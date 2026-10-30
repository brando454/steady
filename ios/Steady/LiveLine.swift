import Foundation

enum LiveLine {
  struct Copy {
    var headline: String
    var detail: String
    var shortName: String
  }

  static func current(session: WorkoutSession, drafts: [String: SetDraft]) -> Copy? {
    let ordered = session.exercises.sorted {
      if $0.sortOrder != $1.sortOrder { return $0.sortOrder < $1.sortOrder }
      return ($0.supersetOrder ?? 0) < ($1.supersetOrder ?? 0)
    }
    guard let open = nextOpen(ordered) else { return nil }
    let mates = roundMates(ordered, open.exercise, open.set)
    if mates.count > 1 {
      let round = mates.map { piece($0.0, $0.1, drafts[$0.1.id], unit: false) }.joined(separator: " · ")
      return Copy(headline: "Set \(open.set.setIndex) · \(round)", detail: "Next: \(round)", shortName: "Superset")
    }
    let exercise = open.exercise
    let phrase = phrase(exercise, open.set, drafts[open.set.id], unit: true)
    let headline = exercise.isCardio
      ? "\(exercise.name) · \(phrase)"
      : "\(exercise.name) · Set \(open.set.setIndex) of \(exercise.setsPlanned) · \(phrase)"
    return Copy(headline: headline, detail: "Next: \(exercise.name) \(phrase)", shortName: exercise.name)
  }

  private static func nextOpen(_ exercises: [SessionExercise]) -> (exercise: SessionExercise, set: WorkoutSet)? {
    for exercise in exercises where exercise.skipped != true {
      if let set = exercise.sets.sorted(by: { $0.setIndex < $1.setIndex }).first(where: { $0.loggedAt == nil && $0.skipped != true }) {
        return (exercise, set)
      }
    }
    return nil
  }

  private static func roundMates(_ exercises: [SessionExercise], _ exercise: SessionExercise, _ set: WorkoutSet) -> [(SessionExercise, WorkoutSet)] {
    guard let group = exercise.supersetGroup, !group.isEmpty else { return [(exercise, set)] }
    let members = exercises.filter { $0.supersetGroup == group && $0.skipped != true }
    let mates = members.compactMap { member -> (SessionExercise, WorkoutSet)? in
      guard let match = member.sets.first(where: { $0.setIndex == set.setIndex && $0.loggedAt == nil && $0.skipped != true }) else { return nil }
      return (member, match)
    }
    return mates.isEmpty ? [(exercise, set)] : mates
  }

  private static func piece(_ exercise: SessionExercise, _ set: WorkoutSet, _ draft: SetDraft?, unit: Bool) -> String {
    let order = exercise.supersetOrder == 1 ? "A1 " : exercise.supersetOrder == 2 ? "A2 " : ""
    return "\(order)\(exercise.name) \(phrase(exercise, set, draft, unit: unit))"
  }

  private static func phrase(_ exercise: SessionExercise, _ set: WorkoutSet, _ draft: SetDraft?, unit: Bool) -> String {
    if exercise.isCardio { return exercise.repsLabel }
    let weight = number(draft?.weight) ?? set.weightLb
    let reps = number(draft?.reps) ?? set.reps
    if exercise.measure == "meters" {
      let distance = reps.map { "\(Format.qty($0)) m" } ?? exercise.repsLabel
      guard let weight else { return distance }
      return "\(Format.qty(weight)) lb × \(distance)"
    }
    let side = exercise.perSide ? " /side" : ""
    let repsText = reps.map { Format.qty($0) } ?? exercise.repsLabel
    guard let weight else { return "\(repsText)\(side)" }
    return unit ? "\(Format.qty(weight)) lb × \(repsText)\(side)" : "\(Format.qty(weight)) × \(repsText)\(side)"
  }

  private static func number(_ text: String?) -> Double? {
    guard let text, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
    return Double(text)
  }
}
