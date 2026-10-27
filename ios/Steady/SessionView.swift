import SwiftUI
import UIKit

struct SessionView: View {
  @EnvironmentObject private var model: AppModel
  var sessionId: String
  @State private var swapExercise: SessionExercise?
  @State private var confirmFinish = false
  @State private var confirmDiscard = false
  @FocusState private var focusedField: SetField?

  var body: some View {
    ScrollViewReader { proxy in
      ScreenStack {
        QuietButton(title: "This week") { model.workoutPath = NavigationPath() }
        if let session = model.session, session.id == sessionId || model.session?.isLocal == true && sessionId.hasPrefix("local-") || model.session?.id == sessionId {
          header(session)
          if session.completedAt != nil {
            if let summary = session.glucose {
              Card { WorkoutGlucoseSummary(summary: summary) }
            }
          } else {
            glucoseCard(session)
          }
          BannerText(text: model.banner)
          ForEach(sessionBlocks(session.exercises)) { block in
            switch block.kind {
            case .single(let exercise):
              exerciseCard(session, exercise).id(exercise.id)
            case .superset(let title, let members):
              supersetCard(session, title, members).id(members.first?.id ?? block.id)
            }
          }
          if session.completedAt == nil {
            Button("Discard workout") { confirmDiscard = true }
              .font(.system(size: 14, weight: .semibold))
              .foregroundStyle(Theme.danger)
              .frame(minHeight: 44)
          }
        } else {
          Text("Loading the workout…").foregroundStyle(Theme.muted)
        }
      }
      .onAppear {
        model.openSession(sessionId)
        if let anchor = model.scrollAnchor[sessionId] {
          DispatchQueue.main.async {
            proxy.scrollTo(anchor, anchor: .center)
          }
        }
      }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) { dock }
    .sheet(item: $swapExercise) { exercise in
      SwapSheet(exercise: exercise) { swapExercise = nil }
    }
    .confirmationDialog("Finish this workout?", isPresented: $confirmFinish, titleVisibility: .visible) {
      Button("Finish") { model.finishWorkout() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("It will count for this week.")
    }
    .confirmationDialog("Discard this workout?", isPresented: $confirmDiscard, titleVisibility: .visible) {
      Button("Discard", role: .destructive) { model.discardWorkout() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Logged sets in it will be removed.")
    }
    .toolbar(.hidden, for: .navigationBar)
  }

  @ViewBuilder private func header(_ session: WorkoutSession) -> some View {
    Text(session.name).font(.system(size: 20, weight: .semibold))
    if let note = session.rampNote, !note.isEmpty {
      Text(note).font(.system(size: 13)).foregroundStyle(Theme.warn)
    }
  }

  @ViewBuilder private func glucoseCard(_ session: WorkoutSession) -> some View {
    if let glucose = model.glucose, glucose.shows, let mgdl = glucose.mgdl {
      let low = mgdl < 120
      let high = mgdl > 180
      let cardioLeft = session.exercises.contains { $0.isCardio && $0.sets.allSatisfy { $0.loggedAt == nil } }
      Card {
        HStack {
          Text("\(Int(mgdl.rounded()))")
            .font(.system(size: 22, weight: .light))
            .foregroundStyle(low ? Theme.warn : (high ? Theme.danger : Theme.text))
          Text(glucose.arrow ?? "")
            .font(.system(size: 18, weight: .light))
          Spacer()
          Text(glucose.label ?? "")
            .font(.system(size: 12))
            .foregroundStyle(Theme.muted)
        }
        if low && cardioLeft {
          Text("Under 120 with cardio ahead, grab a quick snack")
            .font(.system(size: 13))
            .foregroundStyle(Theme.warn)
        }
      }
    }
  }

  private func supersetCard(_ session: WorkoutSession, _ title: String, _ members: [SessionExercise]) -> some View {
    let indexes = Array(Set(members.flatMap { $0.sets.map(\.setIndex) })).sorted()
    return Card {
      Text(title).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
      ForEach(members) { exercise in
        VStack(alignment: .leading, spacing: 4) {
          HStack(alignment: .top) {
            Button {
              model.remember(key: session.id, anchor: exercise.id)
              model.workoutPath.append(WorkoutRoute.exercise(exercise.exerciseId))
            } label: {
              Text(exercise.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
            }
            .buttonStyle(.plain)
            Spacer()
            if session.completedAt == nil {
              Button("Swap") {
                model.remember(key: session.id, anchor: exercise.id)
                swapExercise = exercise
              }
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(Theme.accent)
            }
          }
          Text("Last time: \(exercise.lastTime). PR \(exercise.prLine)")
            .font(.system(size: 12, weight: .regular))
            .foregroundStyle(Theme.muted)
        }
        .id(exercise.id)
      }
      ForEach(indexes, id: \.self) { index in
        let round = members.compactMap { exercise -> (SessionExercise, WorkoutSet)? in
          guard let set = exercise.sets.first(where: { $0.setIndex == index }) else { return nil }
          return (exercise, set)
        }
        let current = round.contains { model.currentSetId == $0.1.id && $0.1.loggedAt == nil }
        VStack(alignment: .leading, spacing: 12) {
          HStack(spacing: 8) {
            Text(round.allSatisfy { $0.1.loggedAt != nil } ? "Set \(index) done" : "Set \(index)")
              .font(.system(size: 13, weight: current ? .semibold : .regular))
              .foregroundStyle(Theme.text)
            if round.contains(where: { model.freshPr.contains($0.1.id) }) {
              Text("New PR").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.ok)
            } else if round.contains(where: { $0.1.isPr }) {
              Text("PR").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.ok)
            }
          }
          ForEach(round.map { RoundMove(exercise: $0.0, set: $0.1) }) { item in
            VStack(alignment: .leading, spacing: 6) {
              HStack(spacing: 6) {
                Text(item.exercise.name).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text)
                if item.set.migrated == true {
                  Text("Migrated").font(.system(size: 11, weight: .regular)).foregroundStyle(Theme.muted)
                }
                if model.freshPr.contains(item.set.id) {
                  Text("New PR").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.ok)
                } else if item.set.isPr {
                  Text("PR").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.ok)
                }
              }
              movementSteppers(session, item.exercise, item.set)
            }
          }
        }
        .padding(10)
        .background(current ? Theme.accentSoft : Theme.bg)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
      }
      if session.completedAt == nil, let first = members.first {
        HStack {
          Button("Remove set") { model.removeLastSet(exerciseId: first.id) }
          Spacer()
          Button("Add set") { model.addSet(exerciseId: first.id) }
        }
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Theme.accent)
      }
    }
  }

  @ViewBuilder private func movementSteppers(_ session: WorkoutSession, _ exercise: SessionExercise, _ set: WorkoutSet) -> some View {
    let locked = set.loggedAt != nil || session.completedAt != nil
    HStack(spacing: 8) {
      stepper(
        label: "\(exercise.name) weight",
        field: .weight(set.id),
        text: Binding(
          get: { model.drafts[set.id]?.weight ?? "" },
          set: { value in
            var draft = model.drafts[set.id] ?? SetDraft(set: set, exercise: exercise)
            draft.weight = sanitize(value, decimal: true)
            model.currentSetId = set.id
            model.changeDraft(setId: set.id, draft)
          }
        ),
        minus: { model.step(setId: set.id, weight: -1) },
        plus: { model.step(setId: set.id, weight: 1) }
      )
      stepper(
        label: exercise.measure == "meters" ? "\(exercise.name) meters" : "\(exercise.name) reps",
        field: .reps(set.id),
        text: Binding(
          get: { model.drafts[set.id]?.reps ?? "" },
          set: { value in
            var draft = model.drafts[set.id] ?? SetDraft(set: set, exercise: exercise)
            draft.reps = sanitize(value, decimal: false)
            model.currentSetId = set.id
            model.changeDraft(setId: set.id, draft)
          }
        ),
        minus: { model.step(setId: set.id, reps: -1) },
        plus: { model.step(setId: set.id, reps: 1) }
      )
    }
    .disabled(locked)
    .opacity(locked ? 0.72 : 1)
  }

  private func exerciseCard(_ session: WorkoutSession, _ exercise: SessionExercise) -> some View {
    Card {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 4) {
          Button {
            model.remember(key: session.id, anchor: exercise.id)
            model.workoutPath.append(WorkoutRoute.exercise(exercise.exerciseId))
          } label: {
            Text(exercise.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
          }
          .buttonStyle(.plain)
          Text(exercise.isCardio ? exercise.repsLabel : "Last time: \(exercise.lastTime). PR \(exercise.prLine)")
            .font(.system(size: 13))
            .foregroundStyle(Theme.muted)
        }
        Spacer()
        if session.completedAt == nil && !exercise.isCardio {
          Button("Swap") {
            model.remember(key: session.id, anchor: exercise.id)
            swapExercise = exercise
          }
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Theme.accent)
        }
      }
      if let notes = exercise.notes, !notes.isEmpty {
        Text(notes).font(.system(size: 13)).foregroundStyle(Theme.muted)
      }
      ForEach(exercise.sets) { set in
        setRow(session, exercise, set)
      }
      if session.completedAt == nil {
        HStack {
          Button("Remove set") { model.removeLastSet(exerciseId: exercise.id) }
          Spacer()
          Button("Add set") { model.addSet(exerciseId: exercise.id) }
        }
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Theme.accent)
      }
    }
  }

  private func setRow(_ session: WorkoutSession, _ exercise: SessionExercise, _ set: WorkoutSet) -> some View {
    let locked = set.loggedAt != nil || session.completedAt != nil
    let current = model.currentSetId == set.id && set.loggedAt == nil
    return VStack(alignment: .leading, spacing: 8) {
      HStack {
        Button {
          if !locked { model.currentSetId = set.id }
        } label: {
          HStack(spacing: 8) {
            Text(set.loggedAt == nil ? "Set \(set.setIndex)" : "Set \(set.setIndex) done")
              .font(.system(size: 13, weight: current ? .semibold : .regular))
              .foregroundStyle(Theme.text)
            if model.freshPr.contains(set.id) {
              Text("New PR").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.ok)
            } else if set.isPr {
              Text("PR").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.ok)
            }
            if set.migrated == true {
              Text("Migrated").font(.system(size: 11, weight: .regular)).foregroundStyle(Theme.muted)
            }
          }
        }
        .buttonStyle(.plain)
        Spacer()
      }
      HStack(spacing: 8) {
          stepper(
            label: exercise.isCardio ? "minutes" : "weight",
            field: exercise.isCardio ? .minutes(set.id) : .weight(set.id),
            text: Binding(
              get: { exercise.isCardio ? (model.drafts[set.id]?.minutes ?? "") : (model.drafts[set.id]?.weight ?? "") },
              set: { value in
                var draft = model.drafts[set.id] ?? SetDraft(set: set, exercise: exercise)
                let clean = sanitize(value, decimal: !exercise.isCardio)
                if exercise.isCardio { draft.minutes = clean } else { draft.weight = clean }
                model.currentSetId = set.id
                model.changeDraft(setId: set.id, draft)
              }
            ),
            minus: {
              if exercise.isCardio { model.step(setId: set.id, minutes: -1) }
              else { model.step(setId: set.id, weight: -1) }
            },
            plus: {
              if exercise.isCardio { model.step(setId: set.id, minutes: 1) }
              else { model.step(setId: set.id, weight: 1) }
            }
          )
          if !exercise.isCardio {
            stepper(
              label: exercise.measure == "meters" ? "meters" : "reps",
              field: .reps(set.id),
              text: Binding(
                get: { model.drafts[set.id]?.reps ?? "" },
                set: { value in
                  var draft = model.drafts[set.id] ?? SetDraft(set: set, exercise: exercise)
                  draft.reps = sanitize(value, decimal: false)
                  model.currentSetId = set.id
                  model.changeDraft(setId: set.id, draft)
                }
              ),
              minus: { model.step(setId: set.id, reps: -1) },
              plus: { model.step(setId: set.id, reps: 1) }
            )
          }
      }
      .disabled(locked)
      .opacity(locked ? 0.72 : 1)
    }
    .padding(10)
    .background(current ? Theme.accentSoft : Color.clear)
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
  }

  private func stepper(label: String, field: SetField, text: Binding<String>, minus: @escaping () -> Void, plus: @escaping () -> Void) -> some View {
    HStack(spacing: 0) {
      Button("−", action: minus).frame(width: 36, height: 40)
      TextField(label, text: text)
        .focused($focusedField, equals: field)
        .accessibilityLabel(label)
        .keyboardType(.decimalPad)
        .multilineTextAlignment(.center)
        .font(.system(size: 16, weight: .regular))
        .frame(minWidth: 44)
      Button("+", action: plus).frame(width: 36, height: 40)
    }
    .foregroundStyle(Theme.text)
    .background(Theme.fill)
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
  }

  private func sanitize(_ value: String, decimal: Bool) -> String {
    var seenDot = false
    return value.filter { char in
      if char.isNumber { return true }
      if decimal && char == "." && !seenDot { seenDot = true; return true }
      return false
    }
  }

  @ViewBuilder private var dock: some View {
    if let session = model.session, session.completedAt == nil, session.id == sessionId || (session.isLocal && sessionId.hasPrefix("local-")) {
      VStack(spacing: 8) {
        HStack {
          TimelineView(.periodic(from: .now, by: 1)) { context in
            let left = model.restEnds.map { max(0, Int($0.timeIntervalSince(context.date).rounded(.up))) }
            VStack(alignment: .leading, spacing: 2) {
              Text(left == nil ? "Rest" : (left == 0 ? "Rest done" : "Rest"))
                .font(.system(size: 12))
                .foregroundStyle(Theme.muted)
              Text(left == nil ? "—" : Format.clock(left ?? 0))
                .font(.system(size: 20, weight: .light))
                .monospacedDigit()
            }
          }
          if model.restEnds != nil {
            Button("+30") { model.adjustRest(by: 30) }
            Button("−15") { model.adjustRest(by: -15) }
            Button("Skip") { model.skipRest() }
          }
          Spacer()
        }
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Theme.accent)
        if !model.notificationsOn && model.restEnds != nil {
          Text("Allow notifications so the rest chime can play with the phone locked.")
            .font(.system(size: 11))
            .foregroundStyle(Theme.muted)
        }
        if let current = current(session), model.drafts[current.set.id] != nil {
          LogSetButton(title: current.exercise.isCardio ? "Log cardio" : "Log set \(current.set.setIndex)") {
            logTapped()
          }
          .frame(maxWidth: .infinity, minHeight: 44)
        } else {
          PrimaryButton(title: "Finish", enabled: !model.busy) { confirmFinish = true }
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 10)
      .padding(.bottom, 8)
      .background(Theme.card)
      .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }
  }

  private func current(_ session: WorkoutSession) -> (exercise: SessionExercise, set: WorkoutSet)? {
    if let id = model.currentSetId,
       let exercise = session.exercises.first(where: { $0.sets.contains { $0.id == id } }),
       let set = exercise.sets.first(where: { $0.id == id }),
       set.loggedAt == nil {
      return (exercise, set)
    }
    return session.currentSet()
  }

  private func logTapped() {
    if let focusedField, let text = FocusedFieldReader.text {
      model.applyFocusedNumber(setId: focusedField.setId, kind: focusedField.kind, text: text)
    }
    model.logCurrent()
    focusedField = nil
  }
}

private enum SetField: Hashable {
  case weight(String)
  case reps(String)
  case minutes(String)

  var setId: String {
    switch self {
    case .weight(let id), .reps(let id), .minutes(let id): return id
    }
  }

  var kind: String {
    switch self {
    case .weight: return "weight"
    case .reps: return "reps"
    case .minutes: return "minutes"
    }
  }
}

private enum FocusedFieldReader {
  static var text: String? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    for scene in scenes {
      for window in scene.windows where window.isKeyWindow {
        return (window.findFirstResponder() as? UITextField)?.text
      }
    }
    return nil
  }
}

private extension UIView {
  func findFirstResponder() -> UIView? {
    if isFirstResponder { return self }
    for child in subviews {
      if let found = child.findFirstResponder() { return found }
    }
    return nil
  }
}

struct SwapSheet: View {
  @EnvironmentObject private var model: AppModel
  var exercise: SessionExercise
  var close: () -> Void
  @State private var custom = ""
  @State private var scope = "today"

  var body: some View {
    NavigationStack {
      ScreenStack {
        Text("Swap \(exercise.name)")
          .font(.system(size: 20, weight: .semibold))
        Text("Just today keeps the program. Default changes the plan from now on.")
          .font(.system(size: 13)).foregroundStyle(Theme.muted)
        Picker("Scope", selection: $scope) {
          Text("Just today").tag("today")
          Text("Make it the default").tag("default")
        }
        .pickerStyle(.segmented)
        ForEach(exercise.swaps) { swap in
          Button {
            model.swap(exerciseId: exercise.id, replacement: swap.id, scope: scope, customName: nil)
            close()
          } label: {
            Text(swap.name)
              .font(.system(size: 15, weight: .semibold))
              .frame(maxWidth: .infinity, alignment: .leading)
              .frame(minHeight: 44)
          }
          .buttonStyle(.plain)
          .foregroundStyle(Theme.text)
        }
        TextField("Or type another lift", text: $custom)
          .padding(12)
          .background(Theme.fill)
          .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        PrimaryButton(title: "Use this name", enabled: !custom.trimmingCharacters(in: .whitespaces).isEmpty) {
          model.swap(exerciseId: exercise.id, replacement: nil, scope: scope, customName: custom)
          close()
        }
      }
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Close", action: close)
        }
      }
    }
  }
}

private struct RoundMove: Identifiable {
  var exercise: SessionExercise
  var set: WorkoutSet
  // `set` is also the setter keyword, so a one-line getter is parsed as a setter.
  var id: String { get { set.id } }
}

private struct SessionBlock: Identifiable {
  enum Kind {
    case single(SessionExercise)
    case superset(title: String, members: [SessionExercise])
  }

  var id: String
  var kind: Kind
}

private func sessionBlocks(_ exercises: [SessionExercise]) -> [SessionBlock] {
  let ordered = exercises.sorted { lhs, rhs in
    if lhs.sortOrder != rhs.sortOrder { return lhs.sortOrder < rhs.sortOrder }
    return (lhs.supersetOrder ?? 0) < (rhs.supersetOrder ?? 0)
  }
  var used = Set<String>()
  var blocks: [SessionBlock] = []
  for exercise in ordered {
    if used.contains(exercise.id) { continue }
    guard let group = exercise.supersetGroup, !group.isEmpty else {
      used.insert(exercise.id)
      blocks.append(SessionBlock(id: exercise.id, kind: .single(exercise)))
      continue
    }
    let members = ordered
      .filter { $0.supersetGroup == group }
      .sorted { ($0.supersetOrder ?? 0) < ($1.supersetOrder ?? 0) }
    for member in members { used.insert(member.id) }
    let title = "Superset · " + members.map(\.name).joined(separator: " + ")
    blocks.append(SessionBlock(id: group, kind: .superset(title: title, members: members)))
  }
  return blocks
}
