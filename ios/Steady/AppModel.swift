import BackgroundTasks
import Foundation
import Network
import SwiftUI
import UIKit
import UserNotifications
import WidgetKit

enum AppTab: String, CaseIterable, Identifiable {
  case today, workout, food, weight
  var id: String { rawValue }
  var title: String {
    switch self {
    case .today: return "Today"
    case .workout: return "Workout"
    case .food: return "Food"
    case .weight: return "Weight"
    }
  }
}

enum WorkoutRoute: Hashable {
  case day(String)
  case session(String)
  case history
  case exercise(String)
  case settings
}

@MainActor
final class AppRuntime {
  static let shared = AppRuntime()
  weak var model: AppModel?
}

@MainActor
final class AppModel: ObservableObject {
  let api = APIClient()
  let rest = RestController()

  @Published var unlocked = false
  @Published var booting = true
  @Published var online = true
  @Published var tab: AppTab = .today
  @Published var civilToday = Boise.civil()
  @Published var today: Today?
  @Published var week: WeekPlan?
  @Published var program: Program?
  @Published var session: WorkoutSession?
  @Published var drafts: [String: SetDraft] = [:]
  @Published var currentSetId: String?
  @Published var freshPr: Set<String> = []
  @Published var food: FoodDay?
  @Published var weights: WeightChart?
  @Published var history: [HistoryItem]?
  @Published var exercisePage: ExerciseHistory?
  @Published var settings: Settings?
  @Published var glucose: Glucose?
  @Published var banner: String?
  @Published var busy = false
  @Published var pending = 0
  @Published var restEnds: Date?
  @Published var restName = ""
  @Published var restPlanned = 0
  @Published var notificationsOn = true
  @Published var workoutPath = NavigationPath()
  @Published var todayPath = NavigationPath()
  @Published var scrollAnchor: [String: String] = [:]

  private var outbox: [OutboxItem] = []
  private var chain: Task<Void, Never>?
  private var monitor: NWPathMonitor?
  private var glucoseTask: Task<Void, Never>?
  private var patchTask: Task<Void, Never>?
  private var syncing = false
  private var draftGeneration = 0
  private var logInFlight = false
  private var foodFollowsToday = true
  private var midnightTimer: Timer?

  func prepare() {
    UNUserNotificationCenter.current().delegate = rest
    BGTaskScheduler.shared.register(forTaskWithIdentifier: "com.brando454.steady.refresh", using: nil) { task in
      guard let refresh = task as? BGAppRefreshTask else { return }
      Task { @MainActor in
        await self.refreshToday()
        refresh.setTaskCompleted(success: true)
        self.scheduleRefresh()
      }
    }
    let monitor = NWPathMonitor()
    monitor.pathUpdateHandler = { [weak self] path in
      Task { @MainActor in
        guard let self else { return }
        let wasOnline = self.online
        self.online = path.status == .satisfied
        if self.online && !wasOnline && self.unlocked { await self.sync() }
      }
    }
    monitor.start(queue: DispatchQueue(label: "steady.network"))
    self.monitor = monitor
    outbox = CacheStore.load([OutboxItem].self, name: "outbox.json") ?? []
    pending = outbox.count
    let day = Boise.civil()
    civilToday = day
    today = cachedToday(day)
    week = CacheStore.load(WeekPlan.self, name: "week.json")
    program = CacheStore.load(Program.self, name: "program.json")
    food = cachedFood(day)
    weights = CacheStore.load(WeightChart.self, name: "weights.json")
    NotificationCenter.default.addObserver(forName: UIApplication.significantTimeChangeNotification, object: nil, queue: .main) { [weak self] _ in
      Task { @MainActor in await self?.rollDay(refetch: true) }
    }
    armMidnightTimer()
    Task { await bootstrap() }
  }

  func becameActive() async {
    await rollDay(refetch: unlocked)
  }

  func setFoodFollowsToday(_ follows: Bool) {
    foodFollowsToday = follows
  }

  func bootstrap() async {
    if let token = KeychainStore.token() {
      api.token = token
      do {
        try await api.me()
        unlocked = true
      } catch APIError.locked {
        if let passcode = KeychainStore.passcode() {
          await login(passcode, interactive: false)
        }
      } catch {
        unlocked = APIError.isOffline(error) && KeychainStore.passcode() != nil
      }
    }
    booting = false
    if unlocked {
      startGlucose()
      await refreshAll()
    }
  }

  func login(_ passcode: String, interactive: Bool = true) async {
    busy = true
    defer { busy = false }
    do {
      let token = try await api.login(passcode: passcode)
      api.token = token
      KeychainStore.save(passcode: passcode)
      KeychainStore.save(token: token)
      unlocked = true
      banner = nil
      startGlucose()
      await refreshAll()
    } catch {
      if interactive { banner = error.localizedDescription }
      if !interactive && APIError.isOffline(error) { unlocked = true }
    }
  }

  func logout() {
    rest.stop()
    restEnds = nil
    api.token = nil
    KeychainStore.clear()
    unlocked = false
    glucoseTask?.cancel()
  }

  func open(url: URL) {
    switch url.host?.lowercased() {
    case "food": tab = .food
    case "workout": tab = .workout
    case "weight": tab = .weight
    default: tab = .today
    }
  }

  func refreshAll() async {
    await refreshToday()
    await refreshProgram()
    await refreshWeek()
    await loadFood(date: nil)
    await loadWeights()
    await loadSettings()
    await sync()
    scheduleRefresh()
  }

  func refreshToday() async {
    let day = Boise.civil()
    if today?.date != day { today = cachedToday(day) }
    do {
      let next = try await api.today()
      guard next.date == Boise.civil() else { return }
      today = next
      CacheStore.save(next, name: "today-\(next.date).json")
      publishWidget(next)
      banner = nil
    } catch APIError.offline {
      online = false
    } catch APIError.locked {
      _ = await relogin()
    } catch {
      if today == nil { banner = error.localizedDescription }
    }
  }

  func refreshProgram() async {
    do {
      let next = try await api.program()
      program = next
      CacheStore.save(next, name: "program.json")
    } catch APIError.offline {
      online = false
    } catch {
      if program == nil { banner = error.localizedDescription }
    }
  }

  func refreshWeek() async {
    do {
      let next = try await api.week()
      week = next
      CacheStore.save(next, name: "week.json")
      for day in next.days where day.status == "in_progress" {
        if let id = day.sessionId {
          await cacheSession(id)
        }
      }
    } catch APIError.offline {
      online = false
    } catch {
      if week == nil { banner = error.localizedDescription }
    }
  }

  func startDay(_ dayId: String) {
    enqueue { await self.startDayNow(dayId) }
  }

  func openSession(_ id: String) {
    enqueue { await self.openSessionNow(id) }
  }

  func showFinishedWorkout(_ id: String) {
    tab = .workout
    var path = NavigationPath()
    path.append(WorkoutRoute.session(id))
    workoutPath = path
    openSession(id)
  }

  func logCurrent() {
    guard !logInFlight else { return }
    logInFlight = true
    draftGeneration += 1
    patchTask?.cancel()
    enqueue {
      await self.logCurrentNow()
      self.logInFlight = false
    }
  }

  /// The focused weight or rep field can be ahead of the draft. Copy it in before logging.
  func applyFocusedNumber(setId: String, kind: String, text: String) {
    guard var draft = drafts[setId] else { return }
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    if kind == "reps" || kind == "minutes" {
      let digits = trimmed.filter(\.isNumber)
      if kind == "reps" { draft.reps = digits } else { draft.minutes = digits }
    } else {
      var seenDot = false
      draft.weight = trimmed.filter { char in
        if char.isNumber { return true }
        if char == "." && !seenDot { seenDot = true; return true }
        return false
      }
    }
    drafts[setId] = draft
    pushLive()
    draftGeneration += 1
    patchTask?.cancel()
  }

  func changeDraft(setId: String, _ draft: SetDraft) {
    drafts[setId] = draft
    pushLive()
    guard let pair = find(setId: setId), pair.set.loggedAt == nil else { return }
    draftGeneration += 1
    let generation = draftGeneration
    patchTask?.cancel()
    patchTask = Task {
      try? await Task.sleep(nanoseconds: 450_000_000)
      if Task.isCancelled || generation != self.draftGeneration { return }
      await self.patch(setId: setId, generation: generation)
    }
  }

  func step(setId: String, weight delta: Int) {
    guard var draft = drafts[setId] else { return }
    let next = max(0, (Double(draft.weight) ?? 0) + Double(delta) * 5)
    draft.weight = Format.qty(next)
    changeDraft(setId: setId, draft)
  }

  func step(setId: String, reps delta: Int) {
    guard var draft = drafts[setId] else { return }
    let next = max(0, (Double(draft.reps) ?? 0) + Double(delta))
    draft.reps = Format.qty(next)
    changeDraft(setId: setId, draft)
  }

  func step(setId: String, minutes delta: Int) {
    guard var draft = drafts[setId] else { return }
    let next = max(0, (Double(draft.minutes) ?? 0) + Double(delta))
    draft.minutes = Format.qty(next)
    changeDraft(setId: setId, draft)
  }

  func addSet(exerciseId: String) { enqueue { await self.addSetNow(exerciseId) } }
  func removeLastSet(exerciseId: String) { enqueue { await self.removeLastNow(exerciseId) } }
  func swap(exerciseId: String, replacement: String?, scope: String, customName: String?) {
    enqueue { await self.swapNow(exerciseId: exerciseId, replacement: replacement, scope: scope, custom: customName) }
  }
  func finishWorkout() { enqueue { await self.finishNow() } }
  func discardWorkout() { enqueue { await self.discardNow() } }

  func adjustRest(by seconds: Int) {
    Task {
      let next = await rest.shift(name: restName, ends: restEnds, by: seconds, planned: restPlanned)
      restEnds = next.ends
      restPlanned = next.planned
    }
  }

  func skipRest() {
    rest.endCountdown()
    restEnds = nil
    pushLive()
  }

  func skipSet(id: String) { enqueue { await self.skipSetNow(id, skipped: true) } }
  func unskipSet(id: String) { enqueue { await self.unskipSetNow(id) } }
  func skipExercise(id: String, pair: Bool) { enqueue { await self.skipExerciseNow(id, pair: pair, skipped: true) } }
  func unskipExercise(id: String, pair: Bool) { enqueue { await self.skipExerciseNow(id, pair: pair, skipped: false) } }

  func loadFood(date requested: String?) async {
    let day = requested?.isEmpty == false ? requested! : Boise.civil()
    if food?.date != day { food = cachedFood(day) }
    do {
      let next = try await api.meals(date: day)
      guard next.date == day else { return }
      food = next
      CacheStore.save(next, name: "food-\(next.date).json")
    } catch APIError.offline {
      online = false
    } catch {
      if food == nil { banner = error.localizedDescription }
    }
  }

  func saveMeal(_ draft: MealDraft, editing: String?) {
    enqueue { await self.saveMealNow(draft, editing: editing) }
  }

  func deleteMeal(_ id: String) { enqueue { await self.deleteMealNow(id) } }
  func logFavorite(_ id: String, date: String, time: String) { enqueue { await self.logFavoriteNow(id, date: date, time: time) } }
  func saveFavorite(name: String, calories: Double, protein: Double, carbs: Double, fat: Double, note: String) {
    enqueue { await self.saveFavoriteNow(name: name, calories: calories, protein: protein, carbs: carbs, fat: fat, note: note) }
  }
  func deleteFavorite(_ id: String) { enqueue { await self.deleteFavoriteNow(id) } }

  static let offlineEstimate = "You're offline, so this can't be estimated yet. Enter the meal yourself. Log meal saves it on this phone until you're back."

  func estimate(note: String, imageDataUrl: String?) async -> MealEstimate? {
    if !online {
      banner = Self.offlineEstimate
      return nil
    }
    do {
      banner = nil
      return try await api.estimate(note: note, imageDataUrl: imageDataUrl)
    } catch {
      if APIError.isOffline(error) {
        online = false
        banner = Self.offlineEstimate
      } else {
        banner = error.localizedDescription
      }
      return nil
    }
  }

  func loadWeights() async {
    do {
      let next = try await api.weights()
      weights = next
      CacheStore.save(next, name: "weights.json")
    } catch APIError.offline {
      online = false
    } catch {
      if weights == nil { banner = error.localizedDescription }
    }
  }

  func saveWeight(_ text: String) { enqueue { await self.saveWeightNow(text) } }

  func loadHistory() async {
    do {
      history = try await api.history()
    } catch APIError.offline {
      online = false
    } catch {
      banner = error.localizedDescription
    }
  }

  func loadExercise(_ id: String) async {
    do {
      exercisePage = try await api.exerciseHistory(id)
    } catch {
      banner = error.localizedDescription
    }
  }

  func loadSettings() async {
    do {
      settings = try await api.settings()
    } catch APIError.offline {
      online = false
    } catch {
      if settings == nil { banner = error.localizedDescription }
    }
  }

  func saveSettings(displayName: String, calories: Double, protein: Double, carbs: Double, fat: Double, weightLb: Double, rampStart: String, week1: Int, week2: Int) {
    enqueue {
      await self.saveSettingsNow(displayName: displayName, calories: calories, protein: protein, carbs: carbs, fat: fat, weightLb: weightLb, rampStart: rampStart, week1: week1, week2: week2)
    }
  }

  func clearSamples() { enqueue { await self.clearSamplesNow() } }

  func remember(key: String, anchor: String) { scrollAnchor[key] = anchor }

  private func startDayNow(_ dayId: String) async {
    busy = true
    defer { busy = false }
    do {
      let next = try await api.startSession(dayId: dayId)
      adopt(next, keepDrafts: false)
      tab = .workout
      workoutPath.append(WorkoutRoute.session(next.id))
      await refreshWeek()
      return
    } catch {
      if !APIError.isOffline(error) {
        banner = error.localizedDescription
        return
      }
      online = false
    }
    if let day = week?.days.first(where: { $0.id == dayId }),
       let existing = day.sessionId,
       let cached = CacheStore.loadSession(existing) {
      adopt(cached, keepDrafts: false)
      tab = .workout
      workoutPath.append(WorkoutRoute.session(cached.id))
      return
    }
    guard let day = program?.days.first(where: { $0.id == dayId }) else {
      banner = "The program isn't on this phone yet. Open the workout once while you're online."
      return
    }
    if let existing = outbox.compactMap({ item -> WorkoutSession? in
      if case .local(let workout) = item, workout.dayId == dayId, workout.session.completedAt == nil { return workout.session }
      return nil
    }).first {
      adopt(existing, keepDrafts: false)
      tab = .workout
      workoutPath.append(WorkoutRoute.session(existing.id))
      return
    }
    let local = makeLocalSession(day)
    outbox.append(.local(LocalWorkout(id: UUID(), dayId: dayId, session: local, actions: [], applied: 0, serverSessionId: nil, idMap: [:])))
    saveOutbox()
    adopt(local, keepDrafts: false)
    tab = .workout
    workoutPath.append(WorkoutRoute.session(local.id))
  }

  private func openSessionNow(_ id: String) async {
    if let cached = CacheStore.loadSession(id) { adopt(cached, keepDrafts: true) }
    guard !id.hasPrefix("local-") else { return }
    do {
      let next = try await api.session(id)
      adopt(next, keepDrafts: true)
    } catch APIError.offline {
      online = false
      if session == nil { banner = "That workout isn't saved on this phone yet." }
    } catch {
      banner = error.localizedDescription
    }
  }

  private func logCurrentNow() async {
    guard let session, let current = currentPair(), current.set.loggedAt == nil else { return }
    let round = unloggedRound(current.exercise, current.set, session)
    let ready = round.compactMap { pair -> (SessionExercise, WorkoutSet, SetDraft)? in
      guard let draft = drafts[pair.1.id] else { return nil }
      return (pair.0, pair.1, draft)
    }
    guard ready.count == round.count, ready.allSatisfy({ canLog($0.0, $0.2) }) else {
      banner = current.exercise.isCardio ? "Enter the minutes" : "Enter the weight and reps"
      return
    }
    let before = Set(session.exercises.flatMap { $0.sets.filter(\.isPr).map(\.id) })
    let label = restLabel(current.exercise, session)
    let reps = ready.map { Double($0.2.reps) ?? $0.0.repCount }.min() ?? current.exercise.repCount
    let superset = ready.count > 1 || (current.exercise.supersetGroup?.isEmpty == false && ready.count >= 1 && !current.exercise.isCardio && supersetMembers(current.exercise, session).count > 1)
    if session.isLocal {
      for item in ready {
        recordLocal(kind: "log", exercise: item.0, set: item.1, draft: item.2, createdSetId: nil, createdExerciseId: nil, swapId: nil, scope: nil, custom: nil)
        markLogged(setId: item.1.id, draft: item.2, exercise: item.0)
      }
      didLogSet()
      if !current.exercise.isCardio { beginRest(name: label, reps: reps) }
      return
    }
    do {
      let next: WorkoutSession
      if superset {
        let sets = ready.map { RoundSetBody(id: $0.1.id, weightLb: Double($0.2.weight) ?? 0, reps: Double($0.2.reps) ?? 0) }
        next = try await api.logRound(session.id, sets: sets)
      } else {
        next = try await api.logSet(ready[0].1.id, body: setBody(ready[0].0, ready[0].2))
      }
      notePrs(before: before, session: next)
      holdLive = true
      adopt(next, keepDrafts: true)
      holdLive = false
      didLogSet()
      if !current.exercise.isCardio { beginRest(name: label, reps: reps) }
      banner = nil
    } catch {
      if APIError.isOffline(error) {
        online = false
        if superset {
          let sets = ready.map { RoundSetBody(id: $0.1.id, weightLb: Double($0.2.weight) ?? 0, reps: Double($0.2.reps) ?? 0) }
          queue(method: "POST", path: "/api/sessions/\(session.id)/rounds", body: ["sets": AnyEncodable(sets)])
        } else {
          queue(method: "POST", path: "/api/sets/\(ready[0].1.id)/log", body: setBody(ready[0].0, ready[0].2))
        }
        for item in ready {
          markLogged(setId: item.1.id, draft: item.2, exercise: item.0)
        }
        didLogSet()
        if !current.exercise.isCardio { beginRest(name: label, reps: reps) }
      } else if await recover(error) {
        await logCurrentNow()
      }
    }
  }

  private func patch(setId: String, generation: Int) async {
    guard generation == draftGeneration else { return }
    guard let pair = find(setId: setId), pair.set.loggedAt == nil, let draft = drafts[setId], let session else { return }
    let body = setBody(pair.exercise, draft)
    if session.isLocal {
      recordLocal(kind: "patch", exercise: pair.exercise, set: pair.set, draft: draft, createdSetId: nil, createdExerciseId: nil, swapId: nil, scope: nil, custom: nil)
      return
    }
    do {
      let next = try await api.patchSet(setId, body: body)
      guard generation == draftGeneration else { return }
      adopt(next, keepDrafts: true)
    } catch {
      if APIError.isOffline(error) {
        online = false
        queue(method: "PATCH", path: "/api/sets/\(setId)", body: body)
      }
    }
  }

  private func addSetNow(_ exerciseId: String) async {
    guard let session, let exercise = session.exercises.first(where: { $0.id == exerciseId }) else { return }
    if supersetMembers(exercise, session).count > 1 {
      await addRoundNow(exercise, session)
      return
    }
    if session.isLocal {
      let newId = "local-\(UUID().uuidString)"
      var next = session
      guard let index = next.exercises.firstIndex(where: { $0.id == exerciseId }) else { return }
      let last = next.exercises[index].sets.max { $0.setIndex < $1.setIndex }
      let set = WorkoutSet(
        id: newId,
        setIndex: (last?.setIndex ?? 0) + 1,
        weightLb: exercise.isCardio ? nil : last?.weightLb,
        reps: exercise.isCardio ? nil : (last?.reps ?? exercise.repCount),
        durationSec: nil,
        note: exercise.isCardio ? last?.note : nil,
        isPr: false,
        prKind: nil,
        loggedAt: nil,
        label: ""
      )
      next.exercises[index].sets.append(set)
      recordLocal(kind: "add", exercise: exercise, set: set, draft: nil, createdSetId: newId, createdExerciseId: nil, swapId: nil, scope: nil, custom: nil)
      replaceLocalSession(next)
      adopt(next, keepDrafts: true)
      return
    }
    do {
      let next = try await api.addSet(exerciseId)
      adopt(next, keepDrafts: true)
    } catch {
      if APIError.isOffline(error) {
        banner = "Adding a set needs a connection on a workout that already lives on the server. Try again when you're back online."
      } else if await recover(error) {
        await addSetNow(exerciseId)
      }
    }
  }

  private func removeLastNow(_ exerciseId: String) async {
    guard let session, let exercise = session.exercises.first(where: { $0.id == exerciseId }) else { return }
    if supersetMembers(exercise, session).count > 1 {
      await removeRoundNow(exercise, session)
      return
    }
    guard let set = exercise.sets.sorted(by: { $0.setIndex < $1.setIndex }).last else { return }
    if exercise.sets.count <= 1 {
      banner = "Keep at least one set"
      return
    }
    if session.isLocal {
      var next = session
      guard let index = next.exercises.firstIndex(where: { $0.id == exerciseId }) else { return }
      next.exercises[index].sets.removeAll { $0.id == set.id }
      recordLocal(kind: "delete", exercise: exercise, set: set, draft: drafts[set.id], createdSetId: nil, createdExerciseId: nil, swapId: nil, scope: nil, custom: nil)
      replaceLocalSession(next)
      adopt(next, keepDrafts: true)
      return
    }
    do {
      let next = try await api.deleteSet(set.id)
      adopt(next, keepDrafts: true)
    } catch {
      if APIError.isOffline(error) {
        online = false
        queue(method: "DELETE", path: "/api/sets/\(set.id)", body: nil)
        var next = session
        if let index = next.exercises.firstIndex(where: { $0.id == exerciseId }) {
          next.exercises[index].sets.removeAll { $0.id == set.id }
          adopt(next, keepDrafts: true)
        }
      } else if await recover(error) {
        await removeLastNow(exerciseId)
      }
    }
  }

  private func swapNow(exerciseId: String, replacement: String?, scope: String, custom: String?) async {
    guard let session, let exercise = session.exercises.first(where: { $0.id == exerciseId }) else { return }
    var body: [String: AnyEncodable] = [
      "sessionExerciseId": AnyEncodable(exerciseId),
      "scope": AnyEncodable(scope),
    ]
    if let replacement, !replacement.isEmpty { body["exerciseId"] = AnyEncodable(replacement) }
    if let custom, !custom.isEmpty { body["customName"] = AnyEncodable(custom) }
    if session.isLocal {
      let name = custom?.isEmpty == false ? custom! : (exercise.swaps.first { $0.id == replacement }?.name ?? replacement ?? exercise.name)
      var next = session
      guard let index = next.exercises.firstIndex(where: { $0.id == exerciseId }) else { return }
      let logged = next.exercises[index].sets.contains { $0.loggedAt != nil }
      let targetId = logged ? "local-\(UUID().uuidString)" : exerciseId
      if logged {
        next.exercises[index].sets.removeAll { $0.loggedAt == nil }
        let remaining = max(1, exercise.setsPlanned - next.exercises[index].sets.count)
        var created = exercise
        created.id = targetId
        created.exerciseId = replacement ?? exercise.exerciseId
        created.name = name
        created.sortOrder = exercise.sortOrder + 1
        created.sets = (1...remaining).map { setIndex in
          WorkoutSet(id: "local-\(UUID().uuidString)", setIndex: setIndex, weightLb: nil, reps: exercise.repCount, durationSec: nil, note: nil, isPr: false, prKind: nil, loggedAt: nil, label: "")
        }
        next.exercises.insert(created, at: index + 1)
      } else {
        next.exercises[index].exerciseId = replacement ?? exercise.exerciseId
        next.exercises[index].name = name
      }
      recordLocal(kind: "swap", exercise: exercise, set: exercise.sets.first, draft: nil, createdSetId: nil, createdExerciseId: logged ? targetId : nil, swapId: replacement, scope: scope, custom: custom)
      replaceLocalSession(next)
      adopt(next, keepDrafts: true)
      return
    }
    do {
      let next = try await api.swap(session.id, body: body)
      adopt(next, keepDrafts: true)
    } catch {
      if APIError.isOffline(error) {
        banner = "Swap needs a connection. It will be here when you're back online."
      } else if await recover(error) {
        await swapNow(exerciseId: exerciseId, replacement: replacement, scope: scope, custom: custom)
      }
    }
  }

  private func finishNow() async {
    guard let session else { return }
    let progressed = session.exercises.contains { $0.skipped == true || $0.sets.contains { $0.loggedAt != nil || $0.skipped == true } }
    if !progressed {
      banner = "Log a set before finishing"
      return
    }
    if session.isLocal, let exercise = session.exercises.first {
      recordLocal(kind: "finish", exercise: exercise, set: nil, draft: nil, createdSetId: nil, createdExerciseId: nil, swapId: nil, scope: nil, custom: nil)
      workoutPath = NavigationPath()
      self.session = nil
      rest.stop()
      restEnds = nil
      await sync()
      return
    }
    do {
      _ = try await api.finish(session.id)
      workoutPath = NavigationPath()
      self.session = nil
      rest.stop()
      restEnds = nil
      await refreshWeek()
      await refreshToday()
    } catch {
      if APIError.isOffline(error) {
        online = false
        queue(method: "POST", path: "/api/sessions/\(session.id)/finish", body: nil)
        workoutPath = NavigationPath()
        self.session = nil
        rest.stop()
        restEnds = nil
      } else if await recover(error) {
        await finishNow()
      }
    }
  }

  private func discardNow() async {
    guard let session else { return }
    if session.isLocal {
      if let index = outbox.firstIndex(where: { item in
        if case .local(let workout) = item { return workout.session.id == session.id }
        return false
      }) {
        if case .local(var workout) = outbox[index], workout.applied == 0 && workout.serverSessionId == nil {
          outbox.remove(at: index)
        } else if case .local(var workout) = outbox[index] {
          workout.actions.append(LocalAction(kind: "discard", exerciseId: "", setId: nil, setIndex: nil, weightLb: nil, reps: nil, minutes: nil, note: nil, isCardio: false, createdSetId: nil, createdExerciseId: nil, swapExerciseId: nil, scope: nil, customName: nil))
          workout.session = session
          outbox[index] = .local(workout)
        }
        saveOutbox()
      }
      workoutPath = NavigationPath()
      self.session = nil
      rest.stop()
      restEnds = nil
      return
    }
    do {
      try await api.discard(session.id)
      workoutPath = NavigationPath()
      self.session = nil
      rest.stop()
      restEnds = nil
      await refreshWeek()
    } catch {
      if APIError.isOffline(error) {
        online = false
        queue(method: "DELETE", path: "/api/sessions/\(session.id)", body: nil)
        workoutPath = NavigationPath()
        self.session = nil
      } else if await recover(error) {
        await discardNow()
      }
    }
  }

  private func saveMealNow(_ draft: MealDraft, editing: String?) async {
    let body = draft.payload
    do {
      if let editing {
        _ = try await api.updateMeal(editing, body: body)
      } else {
        _ = try await api.createMeal(body)
      }
      await loadFood(date: draft.date)
      await refreshToday()
      banner = nil
    } catch {
      if APIError.isOffline(error) {
        online = false
        if let editing {
          queue(method: "PUT", path: "/api/meals/\(editing)", body: body)
        } else {
          queue(method: "POST", path: "/api/meals", body: body)
        }
        banner = "Saved on this phone. It will upload when you're back online."
      } else if await recover(error) {
        await saveMealNow(draft, editing: editing)
      }
    }
  }

  private func deleteMealNow(_ id: String) async {
    do {
      try await api.deleteMeal(id)
      await loadFood(date: food?.date)
      await refreshToday()
    } catch {
      if APIError.isOffline(error) {
        queue(method: "DELETE", path: "/api/meals/\(id)", body: nil)
        food?.meals.removeAll { $0.id == id }
      } else if await recover(error) {
        await deleteMealNow(id)
      }
    }
  }

  private func logFavoriteNow(_ id: String, date: String, time: String) async {
    do {
      _ = try await api.logFavorite(id, date: date, time: time)
      await loadFood(date: date)
      await refreshToday()
    } catch {
      if APIError.isOffline(error) {
        queue(method: "POST", path: "/api/favorites/\(id)/log", body: ["date": AnyEncodable(date), "time": AnyEncodable(time)])
        banner = "The meal will log when you're back online."
      } else if await recover(error) {
        await logFavoriteNow(id, date: date, time: time)
      }
    }
  }

  private func saveFavoriteNow(name: String, calories: Double, protein: Double, carbs: Double, fat: Double, note: String) async {
    let body: [String: AnyEncodable] = [
      "name": AnyEncodable(name),
      "calories": AnyEncodable(calories),
      "protein": AnyEncodable(protein),
      "carbs": AnyEncodable(carbs),
      "fat": AnyEncodable(fat),
      "note": AnyEncodable(note),
    ]
    do {
      _ = try await api.saveFavorite(body)
      await loadFood(date: food?.date)
    } catch {
      if APIError.isOffline(error) {
        queue(method: "POST", path: "/api/favorites", body: body)
        banner = "The saved meal will upload when you're back online."
      } else if await recover(error) {
        await saveFavoriteNow(name: name, calories: calories, protein: protein, carbs: carbs, fat: fat, note: note)
      }
    }
  }

  private func deleteFavoriteNow(_ id: String) async {
    do {
      try await api.deleteFavorite(id)
      await loadFood(date: food?.date)
    } catch {
      if APIError.isOffline(error) {
        queue(method: "DELETE", path: "/api/favorites/\(id)", body: nil)
        food?.favorites.removeAll { $0.id == id }
      } else { banner = error.localizedDescription }
    }
  }

  private func saveWeightNow(_ text: String) async {
    guard let weight = Double(text), weight >= 50 else {
      banner = "Weight looks off"
      return
    }
    do {
      let next = try await api.saveWeight(weightLb: weight, date: nil)
      weights = next
      CacheStore.save(next, name: "weights.json")
      banner = nil
    } catch {
      if APIError.isOffline(error) {
        queue(method: "POST", path: "/api/weights", body: ["weightLb": AnyEncodable(weight)])
        banner = "Weigh-in saved on this phone. It will upload when you're back online."
      } else if await recover(error) {
        await saveWeightNow(text)
      }
    }
  }

  private func saveSettingsNow(displayName: String, calories: Double, protein: Double, carbs: Double, fat: Double, weightLb: Double, rampStart: String, week1: Int, week2: Int) async {
    let body: [String: AnyEncodable] = [
      "displayName": AnyEncodable(displayName),
      "calories": AnyEncodable(calories),
      "protein": AnyEncodable(protein),
      "carbs": AnyEncodable(carbs),
      "fat": AnyEncodable(fat),
      "weightLb": AnyEncodable(weightLb),
      "rampStart": AnyEncodable(rampStart),
      "rampWeek1": AnyEncodable(week1),
      "rampWeek2": AnyEncodable(week2),
    ]
    do {
      settings = try await api.saveSettings(body)
      await refreshToday()
      banner = nil
    } catch {
      banner = error.localizedDescription
    }
  }

  private func clearSamplesNow() async {
    do {
      try await api.clearSamples()
      await refreshAll()
    } catch {
      banner = error.localizedDescription
    }
  }

  private func sync() async {
    guard online, unlocked, !syncing else { return }
    syncing = true
    defer { syncing = false }
    while let item = outbox.first {
      do {
        try await process(item)
        if outbox.first?.id == item.id { outbox.removeFirst() }
        saveOutbox()
      } catch APIError.offline {
        online = false
        return
      } catch APIError.locked {
        if await relogin() { continue }
        return
      } catch {
        banner = error.localizedDescription
        return
      }
    }
    await refreshToday()
  }

  private func process(_ item: OutboxItem) async throws {
    switch item {
    case .http(_, let method, let path, let body):
      do {
        let (data, _) = try await api.sendRaw(method: method, path: path, body: body)
        if let session = try? JSONDecoder().decode(WorkoutSession.self, from: data), !session.exercises.isEmpty, session.name.isEmpty == false {
          adopt(session, keepDrafts: true)
        }
      } catch let error as APIError {
        if case .server(_, let status) = error, status == 404 || status == 409 { return }
        throw error
      }
    case .local(var workout):
      let onlyDiscard = workout.actions.allSatisfy { $0.kind == "discard" || $0.kind == "patch" } && !workout.actions.contains { $0.kind == "log" || $0.kind == "finish" || $0.kind == "add" }
      if workout.serverSessionId == nil && workout.applied == 0 && workout.actions.contains(where: { $0.kind == "discard" }) && !workout.actions.contains(where: { $0.kind == "log" || $0.kind == "finish" }) {
        return
      }
      if onlyDiscard && workout.actions.contains(where: { $0.kind == "discard" }) && workout.serverSessionId == nil {
        return
      }
      let synced = try await SyncEngine.replay(local: &workout, api: api) { updated in
        self.replaceLocal(updated)
      }
      adopt(synced, keepDrafts: false)
    }
  }

  private func beginRest(name: String, reps: Double) {
    let seconds = RestClock.seconds(forReps: reps)
    let planned = max(15, seconds)
    restEnds = Date().addingTimeInterval(TimeInterval(planned))
    restName = name
    restPlanned = planned
    let copy = liveCopy()
    Task {
      let started = await rest.start(name: name, seconds: seconds, detail: copy?.detail ?? "", shortName: copy?.shortName ?? name)
      restEnds = started.ends
      restName = name
      restPlanned = started.planned
      notificationsOn = started.allowed
    }
  }

  private func liveCopy() -> LiveLine.Copy? {
    guard let session else { return nil }
    return LiveLine.current(session: session, drafts: drafts)
  }

  private func skipSetNow(_ id: String, skipped: Bool) async {
    guard let session, let pair = find(setId: id), pair.set.loggedAt == nil else { return }
    if skipped {
      rest.endCountdown()
      restEnds = nil
    }
    if session.isLocal {
      recordLocal(kind: skipped ? "skip" : "unskip", exercise: pair.exercise, set: pair.set, draft: drafts[id], createdSetId: nil, createdExerciseId: nil, swapId: nil, scope: "set", custom: nil)
      markSkipped(setId: id, skipped: skipped)
      return
    }
    do {
      let next = skipped ? try await api.skipSet(id) : try await api.unskipSet(id)
      adopt(next, keepDrafts: true)
    } catch {
      if APIError.isOffline(error) {
        online = false
        queue(method: "POST", path: "/api/sets/\(id)/\(skipped ? "skip" : "unskip")", body: nil)
        markSkipped(setId: id, skipped: skipped)
      } else if await recover(error) {
        await skipSetNow(id, skipped: skipped)
      }
    }
  }

  private func unskipSetNow(_ id: String) async {
    await skipSetNow(id, skipped: false)
  }

  private func skipExerciseNow(_ id: String, pair: Bool, skipped: Bool) async {
    guard let session, let exercise = session.exercises.first(where: { $0.id == id }) else { return }
    if skipped {
      rest.endCountdown()
      restEnds = nil
    }
    let scope = pair ? "pair" : "movement"
    if session.isLocal {
      recordLocal(kind: skipped ? "skip" : "unskip", exercise: exercise, set: nil, draft: nil, createdSetId: nil, createdExerciseId: nil, swapId: nil, scope: scope, custom: nil)
      markExerciseSkipped(id, skipped: skipped, pair: pair)
      return
    }
    do {
      let next = skipped ? try await api.skipExercise(id, sessionId: session.id, scope: scope) : try await api.unskipExercise(id, sessionId: session.id, scope: scope)
      adopt(next, keepDrafts: true)
    } catch {
      if APIError.isOffline(error) {
        online = false
        queue(method: "POST", path: "/api/session-exercises/\(id)/\(skipped ? "skip" : "unskip")", body: ["sessionId": AnyEncodable(session.id), "scope": AnyEncodable(scope)])
        markExerciseSkipped(id, skipped: skipped, pair: pair)
      } else if await recover(error) {
        await skipExerciseNow(id, pair: pair, skipped: skipped)
      }
    }
  }

  private func markSkipped(setId: String, skipped: Bool) {
    guard var session else { return }
    for ei in session.exercises.indices {
      for si in session.exercises[ei].sets.indices where session.exercises[ei].sets[si].id == setId {
        session.exercises[ei].sets[si].skipped = skipped
      }
    }
    if session.isLocal { replaceLocalSession(session) }
    adopt(session, keepDrafts: true)
  }

  private func markExerciseSkipped(_ exerciseId: String, skipped: Bool, pair: Bool) {
    guard var session, let exercise = session.exercises.first(where: { $0.id == exerciseId }) else { return }
    let ids = Set(pair ? supersetMembers(exercise, session).map(\.id) : [exerciseId])
    for ei in session.exercises.indices where ids.contains(session.exercises[ei].id) {
      session.exercises[ei].skipped = skipped
      for si in session.exercises[ei].sets.indices where session.exercises[ei].sets[si].loggedAt == nil {
        if skipped {
          if session.exercises[ei].sets[si].skipped != true {
            session.exercises[ei].sets[si].skipped = true
          }
        } else {
          session.exercises[ei].sets[si].skipped = false
        }
      }
    }
    if session.isLocal { replaceLocalSession(session) }
    adopt(session, keepDrafts: true)
  }

  private func pushLive() {
    guard let session else { return }
    if session.completedAt != nil {
      rest.stop()
      restEnds = nil
      return
    }
    guard let copy = liveCopy() else {
      if restEnds == nil { rest.stop() }
      return
    }
    let resting = restEnds.map { $0 > Date() } ?? false
    let headline = resting ? (restName.isEmpty ? "Rest" : restName) : copy.headline
    let detail = resting ? copy.detail : ""
    Task {
      await rest.show(headline: headline, detail: detail, shortName: copy.shortName, ends: resting ? restEnds : nil, planned: resting ? restPlanned : 1)
    }
  }

  private func queue(method: String, path: String, body: [String: AnyEncodable]?) {
    let data = body.flatMap { try? JSONEncoder().encode($0) }
    outbox.append(.http(id: UUID(), method: method, path: path, body: data))
    saveOutbox()
  }

  private func recordLocal(kind: String, exercise: SessionExercise, set: WorkoutSet?, draft: SetDraft?, createdSetId: String?, createdExerciseId: String?, swapId: String?, scope: String?, custom: String?) {
    guard let session, session.isLocal else { return }
    let action = LocalAction(
      kind: kind,
      exerciseId: exercise.id,
      setId: set?.id,
      setIndex: set?.setIndex,
      weightLb: draft.flatMap { Double($0.weight) },
      reps: draft.flatMap { Double($0.reps) },
      minutes: draft.flatMap { Double($0.minutes) },
      note: draft?.note,
      isCardio: exercise.isCardio,
      createdSetId: createdSetId,
      createdExerciseId: createdExerciseId,
      swapExerciseId: swapId,
      scope: scope,
      customName: custom
    )
    if let index = localIndex(session.id) {
      if case .local(var workout) = outbox[index] {
        if kind == "patch", let last = workout.actions.indices.last, workout.actions[last].kind == "patch", workout.actions[last].setId == set?.id {
          workout.actions[last] = action
        } else {
          workout.actions.append(action)
        }
        workout.session = self.session ?? session
        outbox[index] = .local(workout)
      }
    }
    saveOutbox()
  }

  private func replaceLocalSession(_ session: WorkoutSession) {
    guard let index = localIndex(session.id), case .local(var workout) = outbox[index] else { return }
    workout.session = session
    outbox[index] = .local(workout)
    saveOutbox()
  }

  private func replaceLocal(_ workout: LocalWorkout) {
    guard let index = outbox.firstIndex(where: { $0.id == workout.id }) else { return }
    outbox[index] = .local(workout)
    saveOutbox()
  }

  private func localIndex(_ sessionId: String) -> Int? {
    outbox.firstIndex { item in
      if case .local(let workout) = item { return workout.session.id == sessionId }
      return false
    }
  }

  private func saveOutbox() {
    pending = outbox.count
    CacheStore.save(outbox, name: "outbox.json")
  }

  private func adopt(_ session: WorkoutSession, keepDrafts: Bool) {
    self.session = session
    CacheStore.saveSession(session)
    if !keepDrafts { drafts = [:] }
    for exercise in session.exercises {
      for set in exercise.sets where drafts[set.id] == nil || set.loggedAt != nil {
        drafts[set.id] = SetDraft(set: set, exercise: exercise)
      }
    }
    let currentExercise = session.exercises.first { $0.sets.contains { $0.id == currentSetId } }
    let currentSet = currentExercise?.sets.first { $0.id == currentSetId }
    let currentStillOpen = currentSet?.loggedAt == nil && currentSet?.skipped != true && currentExercise?.skipped != true
    if !currentStillOpen { currentSetId = session.currentSet()?.set.id }
    if session.completedAt != nil {
      rest.stop()
      restEnds = nil
    } else if !holdLive {
      pushLive()
    }
  }

  private var holdLive = false

  private func markLogged(setId: String, draft: SetDraft, exercise: SessionExercise) {
    guard var session else { return }
    for ei in session.exercises.indices {
      for si in session.exercises[ei].sets.indices where session.exercises[ei].sets[si].id == setId {
        session.exercises[ei].sets[si].loggedAt = ISO8601DateFormatter().string(from: Date())
        session.exercises[ei].sets[si].weightLb = Double(draft.weight)
        session.exercises[ei].sets[si].reps = Double(draft.reps)
        session.exercises[ei].sets[si].note = draft.note.isEmpty ? nil : draft.note
        if exercise.isCardio {
          let minutes = Double(draft.minutes) ?? 0
          session.exercises[ei].sets[si].durationSec = minutes * 60
          session.exercises[ei].sets[si].label = "\(Format.qty(minutes)) min"
        } else {
          session.exercises[ei].sets[si].label = Format.performance(
            weight: Double(draft.weight),
            reps: Double(draft.reps),
            measure: exercise.measure,
            perSide: exercise.perSide
          )
        }
      }
    }
    if session.isLocal { replaceLocalSession(session) }
    holdLive = true
    adopt(session, keepDrafts: true)
    holdLive = false
  }

  private func notePrs(before: Set<String>, session: WorkoutSession) {
    let fresh = Set(session.exercises.flatMap { $0.sets.filter { $0.isPr && !before.contains($0.id) }.map(\.id) })
    guard !fresh.isEmpty else { return }
    freshPr.formUnion(fresh)
    Task {
      try? await Task.sleep(nanoseconds: 4_000_000_000)
      freshPr.subtract(fresh)
    }
  }

  private func currentPair() -> (exercise: SessionExercise, set: WorkoutSet)? {
    guard let session else { return nil }
    if let id = currentSetId, let pair = find(setId: id), pair.set.loggedAt == nil, pair.set.skipped != true, pair.exercise.skipped != true { return pair }
    return session.currentSet()
  }

  private func supersetMembers(_ exercise: SessionExercise, _ session: WorkoutSession) -> [SessionExercise] {
    guard let group = exercise.supersetGroup, !group.isEmpty else { return [exercise] }
    let members = session.exercises.filter { $0.supersetGroup == group }
    return members.count > 1 ? members.sorted { ($0.supersetOrder ?? 0) < ($1.supersetOrder ?? 0) } : [exercise]
  }

  private func unloggedRound(_ exercise: SessionExercise, _ set: WorkoutSet, _ session: WorkoutSession) -> [(SessionExercise, WorkoutSet)] {
    let members = supersetMembers(exercise, session)
    if members.count < 2 { return [(exercise, set)] }
    let pairs = members.compactMap { member -> (SessionExercise, WorkoutSet)? in
      guard member.skipped != true, let mate = member.sets.first(where: { $0.setIndex == set.setIndex && $0.loggedAt == nil && $0.skipped != true }) else { return nil }
      return (member, mate)
    }
    return pairs.isEmpty ? [(exercise, set)] : pairs
  }

  private func restLabel(_ exercise: SessionExercise, _ session: WorkoutSession) -> String {
    let members = supersetMembers(exercise, session)
    guard members.count > 1 else { return exercise.name }
    return "Superset · " + members.map(\.name).joined(separator: " + ")
  }

  private func addRoundNow(_ exercise: SessionExercise, _ session: WorkoutSession) async {
    let members = supersetMembers(exercise, session)
    if session.isLocal {
      var next = session
      let nextIndex = (members.flatMap(\.sets).map(\.setIndex).max() ?? 0) + 1
      for member in members {
        guard let index = next.exercises.firstIndex(where: { $0.id == member.id }) else { continue }
        let last = next.exercises[index].sets.max { $0.setIndex < $1.setIndex }
        let newId = "local-\(UUID().uuidString)"
        let set = WorkoutSet(
          id: newId,
          setIndex: nextIndex,
          weightLb: member.isCardio ? nil : last?.weightLb,
          reps: member.isCardio ? nil : (last?.reps ?? member.repCount),
          durationSec: nil,
          note: member.isCardio ? last?.note : nil,
          isPr: false,
          prKind: nil,
          loggedAt: nil,
          label: ""
        )
        next.exercises[index].sets.append(set)
        self.session = next
        recordLocal(kind: "add", exercise: member, set: set, draft: nil, createdSetId: newId, createdExerciseId: nil, swapId: nil, scope: nil, custom: nil)
      }
      replaceLocalSession(next)
      adopt(next, keepDrafts: true)
      return
    }
    do {
      let next = try await api.addRound(session.id, sessionExerciseId: exercise.id)
      adopt(next, keepDrafts: true)
    } catch {
      if APIError.isOffline(error) {
        banner = "Adding a set needs a connection on a workout that already lives on the server. Try again when you're back online."
      } else if await recover(error) {
        await addRoundNow(exercise, session)
      }
    }
  }

  private func removeRoundNow(_ exercise: SessionExercise, _ session: WorkoutSession) async {
    let members = supersetMembers(exercise, session)
    if members.contains(where: { $0.sets.count <= 1 }) {
      banner = "Keep at least one set"
      return
    }
    if session.isLocal {
      var next = session
      for member in members {
        guard let index = next.exercises.firstIndex(where: { $0.id == member.id }) else { continue }
        guard let set = next.exercises[index].sets.max(by: { $0.setIndex < $1.setIndex }) else { continue }
        next.exercises[index].sets.removeAll { $0.id == set.id }
        self.session = next
        recordLocal(kind: "delete", exercise: member, set: set, draft: drafts[set.id], createdSetId: nil, createdExerciseId: nil, swapId: nil, scope: nil, custom: nil)
      }
      replaceLocalSession(next)
      adopt(next, keepDrafts: true)
      return
    }
    do {
      let next = try await api.removeRound(session.id, sessionExerciseId: exercise.id)
      adopt(next, keepDrafts: true)
    } catch {
      if APIError.isOffline(error) {
        online = false
        queue(method: "POST", path: "/api/sessions/\(session.id)/rounds/remove", body: ["sessionExerciseId": AnyEncodable(exercise.id)])
        var next = session
        let indexToDrop = members.flatMap(\.sets).map(\.setIndex).max() ?? 0
        for member in members {
          guard let index = next.exercises.firstIndex(where: { $0.id == member.id }) else { continue }
          next.exercises[index].sets.removeAll { $0.setIndex == indexToDrop }
        }
        adopt(next, keepDrafts: true)
      } else if await recover(error) {
        await removeRoundNow(exercise, session)
      }
    }
  }

  private func find(setId: String) -> (exercise: SessionExercise, set: WorkoutSet)? {
    guard let session else { return nil }
    for exercise in session.exercises {
      if let set = exercise.sets.first(where: { $0.id == setId }) { return (exercise, set) }
    }
    return nil
  }

  private func canLog(_ exercise: SessionExercise, _ draft: SetDraft) -> Bool {
    if exercise.isCardio { return (Double(draft.minutes) ?? 0) > 0 }
    return Double(draft.weight) != nil && (Double(draft.reps) ?? 0) > 0
  }

  private func setBody(_ exercise: SessionExercise, _ draft: SetDraft) -> [String: AnyEncodable] {
    if exercise.isCardio {
      return ["minutes": AnyEncodable(Double(draft.minutes)), "note": AnyEncodable(draft.note)]
    }
    return ["weightLb": AnyEncodable(Double(draft.weight)), "reps": AnyEncodable(Double(draft.reps))]
  }

  private func makeLocalSession(_ day: ProgramDay) -> WorkoutSession {
    let exercises = day.exercises.sorted { $0.sortOrder < $1.sortOrder }.map { slot -> SessionExercise in
      let count = max(slot.sets, 1)
      let sets = (1...count).map { index in
        WorkoutSet(
          id: "local-\(UUID().uuidString)",
          setIndex: index,
          weightLb: slot.isCardio ? nil : slot.lastWeightLb,
          reps: slot.isCardio ? nil : slot.repCount,
          durationSec: slot.isCardio ? (slot.cardioMin ?? 0) * 60 : nil,
          note: slot.isCardio ? slot.notes : nil,
          isPr: false,
          prKind: nil,
          loggedAt: nil,
          label: ""
        )
      }
      return SessionExercise(
        id: "local-\(UUID().uuidString)",
        exerciseId: slot.exerciseId,
        name: slot.name,
        patternLabel: slot.patternLabel,
        muscles: slot.muscles,
        sortOrder: slot.sortOrder,
        isCardio: slot.isCardio,
        setsPlanned: slot.sets,
        repsLabel: slot.repsLabel,
        repCount: slot.repCount,
        measure: slot.measure,
        perSide: slot.perSide,
        notes: slot.notes,
        cardioMin: slot.cardioMin,
        lastTime: "—",
        lastWeightLb: slot.lastWeightLb,
        prLine: "—",
        supersetGroup: slot.supersetGroup,
        supersetOrder: slot.supersetOrder,
        swaps: slot.swaps,
        sets: sets
      )
    }
    return WorkoutSession(
      id: "local-\(UUID().uuidString)",
      dayId: day.id,
      name: day.name,
      startedAt: ISO8601DateFormatter().string(from: Date()),
      completedAt: nil,
      weekStart: Boise.weekStart(Boise.civil()),
      rampNote: week?.rampNote,
      exercises: exercises,
      glucose: nil
    )
  }

  private func cacheSession(_ id: String) async {
    if let next = try? await api.session(id) { CacheStore.saveSession(next) }
  }

  private func publishWidget(_ today: Today) {
    let snapshot = WidgetSnapshot(
      date: today.date,
      updatedAt: Date(),
      caloriesEaten: today.totals.calories,
      caloriesTarget: today.targets.calories,
      caloriesLeft: today.left.calories,
      proteinEaten: today.totals.protein,
      proteinTarget: today.targets.protein,
      carbsEaten: today.totals.carbs,
      carbsTarget: today.targets.carbs,
      fatEaten: today.totals.fat,
      fatTarget: today.targets.fat
    )
    AppGroup.saveSnapshot(snapshot)
    WidgetCenter.shared.reloadAllTimelines()
  }

  private func startGlucose() {
    glucoseTask?.cancel()
    glucoseTask = Task {
      while !Task.isCancelled {
        await self.refreshGlucose()
        try? await Task.sleep(nanoseconds: 60_000_000_000)
      }
    }
  }

  func glucoseStatusText() async -> String {
    do {
      return try await api.glucose().statusText
    } catch {
      return "Couldn't check Nightscout"
    }
  }

  private func refreshGlucose() async {
    if let reading = try? await api.glucose() {
      glucose = reading
    }
    if let current = session, current.glucose?.inProgress == true, !current.isLocal {
      if let next = try? await api.session(current.id) {
        session = next
      }
    }
    let day = Boise.civil()
    if today?.date != day || today?.suggestion?.glucose?.inProgress == true {
      await refreshToday()
    }
    let foodLive = food?.glucoseDay != nil || food?.meals.contains(where: { $0.glucose?.inProgress == true }) == true
    if foodFollowsToday && food?.date != day {
      await loadFood(date: day)
    } else if foodLive {
      await loadFood(date: foodFollowsToday ? day : food?.date)
    }
  }

  private func didLogSet() {
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
  }

  private func cachedToday(_ date: String) -> Today? {
    if let dated = CacheStore.load(Today.self, name: "today-\(date).json") { return dated }
    if let legacy = CacheStore.load(Today.self, name: "today.json"), legacy.date == date { return legacy }
    return nil
  }

  private func cachedFood(_ date: String) -> FoodDay? {
    if let dated = CacheStore.load(FoodDay.self, name: "food-\(date).json") { return dated }
    if let legacy = CacheStore.load(FoodDay.self, name: "food.json"), legacy.date == date { return legacy }
    return nil
  }

  private func armMidnightTimer() {
    midnightTimer?.invalidate()
    let timer = Timer(fire: Boise.nextMidnight(), interval: 0, repeats: false) { [weak self] _ in
      Task { @MainActor in await self?.rollDay(refetch: true) }
    }
    RunLoop.main.add(timer, forMode: .common)
    midnightTimer = timer
  }

  private func rollDay(refetch: Bool) async {
    let day = Boise.civil()
    let changed = day != civilToday
    civilToday = day
    if changed {
      if today?.date != day { today = cachedToday(day) }
      if foodFollowsToday && food?.date != day { food = cachedFood(day) }
    }
    armMidnightTimer()
    guard refetch, unlocked else { return }
    await refreshToday()
    await refreshWeek()
    if foodFollowsToday {
      await loadFood(date: day)
    }
  }

  private func relogin() async -> Bool {
    guard let passcode = KeychainStore.passcode() else {
      unlocked = false
      return false
    }
    do {
      let token = try await api.login(passcode: passcode)
      api.token = token
      KeychainStore.save(token: token)
      return true
    } catch {
      if !APIError.isOffline(error) { unlocked = false }
      return false
    }
  }

  private func recover(_ error: Error) async -> Bool {
    if case APIError.locked = error { return await relogin() }
    banner = error.localizedDescription
    return false
  }

  private func enqueue(_ work: @escaping @MainActor () async -> Void) {
    let previous = chain
    chain = Task { @MainActor in
      await previous?.value
      await work()
    }
  }

  private func scheduleRefresh() {
    let request = BGAppRefreshTaskRequest(identifier: "com.brando454.steady.refresh")
    request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
    try? BGTaskScheduler.shared.submit(request)
  }
}
