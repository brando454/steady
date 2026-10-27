import BackgroundTasks
import Foundation
import Network
import SwiftUI
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
    today = CacheStore.load(Today.self, name: "today.json")
    week = CacheStore.load(WeekPlan.self, name: "week.json")
    program = CacheStore.load(Program.self, name: "program.json")
    food = CacheStore.load(FoodDay.self, name: "food.json")
    weights = CacheStore.load(WeightChart.self, name: "weights.json")
    Task { await bootstrap() }
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
    do {
      let next = try await api.today()
      today = next
      CacheStore.save(next, name: "today.json")
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
    enqueue { await self.logCurrentNow() }
  }

  func changeDraft(setId: String, _ draft: SetDraft) {
    drafts[setId] = draft
    guard let pair = find(setId: setId), pair.set.loggedAt == nil else { return }
    patchTask?.cancel()
    patchTask = Task {
      try? await Task.sleep(nanoseconds: 450_000_000)
      if Task.isCancelled { return }
      await self.patch(setId: setId)
    }
  }

  func step(setId: String, weight delta: Int) {
    guard var draft = drafts[setId] else { return }
    let next = max(0, (Double(draft.weight) ?? 0) + Double(delta) * 5)
    draft.weight = Format.qty(next)
    drafts[setId] = draft
    Task { await patch(setId: setId) }
  }

  func step(setId: String, reps delta: Int) {
    guard var draft = drafts[setId] else { return }
    let next = max(0, (Double(draft.reps) ?? 0) + Double(delta))
    draft.reps = Format.qty(next)
    drafts[setId] = draft
    Task { await patch(setId: setId) }
  }

  func step(setId: String, minutes delta: Int) {
    guard var draft = drafts[setId] else { return }
    let next = max(0, (Double(draft.minutes) ?? 0) + Double(delta))
    draft.minutes = Format.qty(next)
    drafts[setId] = draft
    Task { await patch(setId: setId) }
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
    rest.stop()
    restEnds = nil
  }

  func loadFood(date: String?) async {
    do {
      let next = try await api.meals(date: date)
      food = next
      CacheStore.save(next, name: "food.json")
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
    guard let session, let current = currentPair(), let draft = drafts[current.set.id] else { return }
    guard canLog(current.exercise, draft) else {
      banner = current.exercise.isCardio ? "Enter the minutes" : "Enter the weight and reps"
      return
    }
    let before = Set(session.exercises.flatMap { $0.sets.filter(\.isPr).map(\.id) })
    let body = setBody(current.exercise, draft)
    if session.isLocal {
      recordLocal(kind: "log", exercise: current.exercise, set: current.set, draft: draft, createdSetId: nil, createdExerciseId: nil, swapId: nil, scope: nil, custom: nil)
      markLogged(setId: current.set.id, draft: draft, exercise: current.exercise)
      beginRest(current.exercise, draft)
      return
    }
    do {
      let next = try await api.logSet(current.set.id, body: body)
      notePrs(before: before, session: next)
      adopt(next, keepDrafts: true)
      beginRest(current.exercise, draft)
      banner = nil
    } catch {
      if APIError.isOffline(error) {
        online = false
        queue(method: "POST", path: "/api/sets/\(current.set.id)/log", body: body)
        markLogged(setId: current.set.id, draft: draft, exercise: current.exercise)
        beginRest(current.exercise, draft)
      } else if await recover(error) {
        await logCurrentNow()
      }
    }
  }

  private func patch(setId: String) async {
    guard let pair = find(setId: setId), pair.set.loggedAt == nil, let draft = drafts[setId], let session else { return }
    let body = setBody(pair.exercise, draft)
    if session.isLocal {
      recordLocal(kind: "patch", exercise: pair.exercise, set: pair.set, draft: draft, createdSetId: nil, createdExerciseId: nil, swapId: nil, scope: nil, custom: nil)
      return
    }
    do {
      let next = try await api.patchSet(setId, body: body)
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
    let logged = session.exercises.contains { $0.sets.contains { $0.loggedAt != nil } }
    if !logged {
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

  private func beginRest(_ exercise: SessionExercise, _ draft: SetDraft) {
    guard !exercise.isCardio else { return }
    let reps = Double(draft.reps) ?? exercise.repCount
    let seconds = RestClock.seconds(forReps: reps)
    Task {
      let started = await rest.start(name: exercise.name, seconds: seconds)
      restEnds = started.ends
      restName = exercise.name
      restPlanned = started.planned
      notificationsOn = started.allowed
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
    let currentStillOpen = session.exercises.flatMap(\.sets).first { $0.id == currentSetId }?.loggedAt == nil
    if !currentStillOpen { currentSetId = session.currentSet()?.set.id }
  }

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
    adopt(session, keepDrafts: true)
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
    if let id = currentSetId, let pair = find(setId: id), pair.set.loggedAt == nil { return pair }
    return session.currentSet()
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
    if today?.suggestion?.glucose?.inProgress == true {
      await refreshToday()
    }
    if food?.glucoseDay != nil || food?.meals.contains(where: { $0.glucose?.inProgress == true }) == true {
      await loadFood(date: food?.date)
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
