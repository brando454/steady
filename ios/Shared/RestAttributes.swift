import ActivityKit
import Foundation

struct RestAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var endsAt: Date
  }

  var exerciseName: String
  var plannedSeconds: Int
}

enum RestClock {
  static func range(endsAt: Date, plannedSeconds: Int) -> ClosedRange<Date> {
    let start = endsAt.addingTimeInterval(-Double(max(plannedSeconds, 1)))
    if start <= endsAt { return start...endsAt }
    return endsAt...endsAt
  }

  static func seconds(forReps reps: Double) -> Int {
    if reps <= 6 { return 150 }
    if reps <= 10 { return 90 }
    return 60
  }
}
