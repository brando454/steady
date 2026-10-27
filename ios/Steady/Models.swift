import Foundation

struct NamedSwap: Codable, Hashable, Identifiable {
  var id: String
  var name: String
}

struct WorkoutSet: Codable, Identifiable, Hashable {
  var id: String
  var setIndex: Int
  var weightLb: Double?
  var reps: Double?
  var durationSec: Double?
  var note: String?
  var isPr: Bool
  var prKind: String?
  var loggedAt: String?
  var label: String
  var migrated: Bool? = nil
}

struct SessionExercise: Codable, Identifiable, Hashable {
  var id: String
  var exerciseId: String
  var name: String
  var patternLabel: String
  var muscles: String
  var sortOrder: Int
  var isCardio: Bool
  var setsPlanned: Int
  var repsLabel: String
  var repCount: Double
  var measure: String
  var perSide: Bool
  var notes: String?
  var cardioMin: Double?
  var lastTime: String
  var lastWeightLb: Double?
  var prLine: String
  var supersetGroup: String? = nil
  var supersetOrder: Int? = nil
  var swaps: [NamedSwap]
  var sets: [WorkoutSet]
}

struct WorkoutSession: Codable, Identifiable, Hashable {
  var id: String
  var dayId: String?
  var name: String
  var startedAt: String
  var completedAt: String?
  var weekStart: String
  var rampNote: String?
  var exercises: [SessionExercise]
  var glucose: WorkoutGlucose?

  var isLocal: Bool { id.hasPrefix("local-") }

  func currentSet() -> (exercise: SessionExercise, set: WorkoutSet)? {
    for exercise in exercises {
      if let set = exercise.sets.first(where: { $0.loggedAt == nil }) {
        return (exercise, set)
      }
    }
    return nil
  }
}

struct ProgramExercise: Codable, Identifiable, Hashable {
  var programExerciseId: Int
  var exerciseId: String
  var name: String
  var patternLabel: String
  var muscles: String
  var sortOrder: Int
  var sets: Int
  var repsLabel: String
  var repCount: Double
  var measure: String
  var perSide: Bool
  var notes: String?
  var isCardio: Bool
  var cardioMin: Double?
  var supersetGroup: String? = nil
  var supersetOrder: Int? = nil
  var swaps: [NamedSwap]
  var lastWeightLb: Double?
  var id: String { exerciseId + "-\(programExerciseId)" }
}

struct ProgramDay: Codable, Identifiable, Hashable {
  var id: String
  var name: String
  var summary: String
  var sortOrder: Int
  var exercises: [ProgramExercise]
}

struct Program: Codable {
  var days: [ProgramDay]
}

struct DayPlan: Codable, Identifiable, Hashable {
  var id: String
  var name: String
  var summary: String
  var status: String
  var suggested: Bool
  var doneWeekday: String?
  var sessionId: String?
  var exercises: [DayExercise]
}

struct DayExercise: Codable, Hashable {
  var name: String
  var detail: String
  var isCardio: Bool
}

struct WeekPlan: Codable {
  var weekStart: String
  var weekEnd: String
  var rangeLabel: String
  var doneCount: Int
  var total: Int
  var rampNote: String?
  var days: [DayPlan]
}

struct Macros: Codable, Hashable {
  var calories: Double
  var protein: Double
  var carbs: Double
  var fat: Double
}

struct Meal: Codable, Identifiable, Hashable {
  var id: String
  var name: String
  var calories: Double
  var protein: Double
  var carbs: Double
  var fat: Double
  var note: String?
  var photo: String?
  var loggedAt: String
  var timeLabel: String
  var date: String
  var glucose: MealGlucose?
}

struct Favorite: Codable, Identifiable, Hashable {
  var id: String
  var name: String
  var calories: Double
  var protein: Double
  var carbs: Double
  var fat: Double
  var note: String?
}

struct TodaySuggestion: Codable, Hashable {
  var dayId: String
  var name: String
  var status: String
  var sessionId: String?
  var rampNote: String?
  var summary: String
  var lines: [String]
  var completedToday: Bool = false
  var prCount: Int = 0
  var setCount: Int = 0
  var resultLine: String = ""
  var glucose: WorkoutGlucose?

  enum CodingKeys: String, CodingKey {
    case dayId, name, status, sessionId, rampNote, summary, lines
    case completedToday, prCount, setCount, resultLine, glucose
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    dayId = try container.decode(String.self, forKey: .dayId)
    name = try container.decode(String.self, forKey: .name)
    status = try container.decode(String.self, forKey: .status)
    sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
    rampNote = try container.decodeIfPresent(String.self, forKey: .rampNote)
    summary = try container.decode(String.self, forKey: .summary)
    lines = try container.decodeIfPresent([String].self, forKey: .lines) ?? []
    completedToday = try container.decodeIfPresent(Bool.self, forKey: .completedToday) ?? false
    prCount = try container.decodeIfPresent(Int.self, forKey: .prCount) ?? 0
    setCount = try container.decodeIfPresent(Int.self, forKey: .setCount) ?? 0
    resultLine = try container.decodeIfPresent(String.self, forKey: .resultLine) ?? ""
    glucose = try container.decodeIfPresent(WorkoutGlucose.self, forKey: .glucose)
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(dayId, forKey: .dayId)
    try container.encode(name, forKey: .name)
    try container.encode(status, forKey: .status)
    try container.encodeIfPresent(sessionId, forKey: .sessionId)
    try container.encodeIfPresent(rampNote, forKey: .rampNote)
    try container.encode(summary, forKey: .summary)
    try container.encode(lines, forKey: .lines)
    try container.encode(completedToday, forKey: .completedToday)
    try container.encode(prCount, forKey: .prCount)
    try container.encode(setCount, forKey: .setCount)
    try container.encode(resultLine, forKey: .resultLine)
    try container.encodeIfPresent(glucose, forKey: .glucose)
  }
}

struct WorkoutGlucosePoint: Codable, Hashable {
  var minute: Double
  var mgdl: Int
}

struct WorkoutGlucose: Codable, Hashable {
  var inProgress: Bool
  var unavailable: Bool
  var startMgdl: Int?
  var endMgdl: Int?
  var averageMgdl: Int?
  var lowDuringMgdl: Int?
  var lowAfterMgdl: Int?
  var workoutMinutes: Double
  var windowMinutes: Double
  var points: [WorkoutGlucosePoint]
}

struct MealGlucosePoint: Codable, Hashable {
  var minute: Double
  var mgdl: Int
}

struct MealGlucose: Codable, Hashable {
  var inProgress: Bool
  var unavailable: Bool
  var atMgdl: Int?
  var peakMgdl: Int?
  var peakMinute: Int?
  var riseMgdl: Int?
  var lowAfterMgdl: Int?
  var points: [MealGlucosePoint]
}

struct DayGlucosePoint: Codable, Hashable {
  var minute: Double
  var mgdl: Int
}

struct DayMarker: Codable, Hashable, Identifiable {
  var id: String
  var kind: String
  var name: String
  var minute: Double
  var mgdl: Int?
  var calories: Double?
  var protein: Double?
  var carbs: Double?
  var fat: Double?
}

struct DayGlucose: Codable, Hashable {
  var unavailable: Bool
  var spanMinutes: Double
  var points: [DayGlucosePoint]
  var markers: [DayMarker]
}

struct Today: Codable {
  var date: String
  var dateLabel: String
  var greeting: String
  var targets: Targets
  var totals: Macros
  var left: Macros
  var meals: [Meal]
  var suggestion: TodaySuggestion?
  var weekDone: Int
  var weekTotal: Int

  struct Targets: Codable, Hashable {
    var calories: Double
    var protein: Double
    var carbs: Double
    var fat: Double
    var weightLb: Double
  }
}

struct FoodDay: Codable {
  var date: String
  var today: String
  var nowTime: String
  var meals: [Meal]
  var favorites: [Favorite]
  var aiConfigured: Bool
  var totals: Macros?
  var targets: Macros?
  var left: Macros?
  var glucoseDay: DayGlucose?
}

struct MealEstimate: Codable {
  var name: String
  var calories: Double
  var protein: Double
  var carbs: Double
  var fat: Double
}

struct RampWeek: Codable, Hashable {
  var offset: Int
  var percent: Int
}

struct Ramp: Codable, Hashable {
  var startDate: String
  var weeks: [RampWeek]
}

struct Settings: Codable {
  var displayName: String
  var calories: Double
  var protein: Double
  var carbs: Double
  var fat: Double
  var weightLb: Double
  var ramp: Ramp
  var rampNote: String?
  var aiConfigured: Bool
  var samples: Bool
}

struct WeightPoint: Codable, Hashable, Identifiable {
  var date: String
  var weightLb: Double?
  var average: Double?
  var id: String { date }
}

struct WeightHint: Codable, Hashable {
  var tone: String
  var text: String
}

struct WeightChart: Codable {
  var target: Double
  var average: Double?
  var count: Int
  var change: Double?
  var hint: WeightHint
  var today: Double?
  var points: [WeightPoint]
}

struct HistoryItem: Codable, Identifiable, Hashable {
  var id: String
  var name: String
  var date: String
  var dateLabel: String
  var weekday: String
  var durationLabel: String
  var prCount: Int
  var finished: Bool
}

struct ExerciseHistory: Codable, Identifiable {
  var id: String
  var name: String
  var measure: String
  var best: Best?
  var chartLabel: String
  var series: [Point]
  var sessions: [Past]

  struct Best: Codable {
    var label: String
    var e1rm: Double?
    var dateLabel: String
  }

  struct Point: Codable, Identifiable {
    var date: String
    var value: Double
    var label: String
    var id: String { date + label }
  }

  struct Past: Codable, Identifiable {
    var sessionId: String
    var dateLabel: String
    var workoutName: String
    var sets: [PastSet]
    var id: String { sessionId + dateLabel }
  }

  struct PastSet: Codable, Hashable {
    var label: String
    var isPr: Bool
  }
}

struct Glucose: Codable {
  var available: Bool
  var reason: String?
  var detail: String?
  var mgdl: Double?
  var arrow: String?
  var label: String?
  var at: String?
  var minutesAgo: Int?

  var shows: Bool { mgdl != nil && (available || reason == "stale") }

  var statusText: String {
    if available, let mgdl {
      let when = (minutesAgo ?? 0) == 0 ? "just now" : "\(minutesAgo ?? 0) min ago"
      return "\(Int(mgdl.rounded())) mg/dL · \(when)"
    }
    if reason == "stale", let mgdl {
      let when = (minutesAgo ?? 0) == 0 ? "just now" : "\(minutesAgo ?? 0) min ago"
      return "\(Int(mgdl.rounded())) mg/dL · \(when). Older than 15 minutes."
    }
    if reason == "not_configured" {
      let missing = detail ?? "NIGHTSCOUT_URL or NIGHTSCOUT_TOKEN"
      return missing.contains(" and ") ? "\(missing) aren't set on the server" : "\(missing) isn't set on the server"
    }
    if let reason, reason.hasPrefix("http_") { return "Nightscout returned HTTP \(reason.dropFirst("http_".count))" }
    if reason == "timeout" { return "Nightscout timed out" }
    if reason == "network" {
      return detail == nil ? "Couldn't reach Nightscout" : "Couldn't reach Nightscout (\(detail ?? ""))"
    }
    if reason == "bad_payload" { return "Nightscout's reply wasn't a reading" }
    return "Nightscout isn't available"
  }
}

struct SetDraft: Equatable {
  var weight: String
  var reps: String
  var minutes: String
  var note: String

  init(set: WorkoutSet, exercise: SessionExercise) {
    weight = Format.qty(set.weightLb)
    reps = Format.qty(set.reps)
    if exercise.isCardio {
      if let seconds = set.durationSec {
        minutes = Format.qty(seconds / 60)
      } else if let cardio = exercise.cardioMin {
        minutes = Format.qty(cardio)
      } else {
        minutes = ""
      }
    } else {
      minutes = ""
    }
    note = set.note ?? ""
  }
}

struct MealDraft: Codable, Equatable {
  var name: String
  var calories: String
  var protein: String
  var carbs: String
  var fat: String
  var note: String
  var photo: String?
  var date: String
  var time: String

  static let empty = MealDraft(name: "", calories: "", protein: "", carbs: "", fat: "", note: "", photo: nil, date: "", time: "")

  var payload: [String: AnyEncodable] {
    [
      "name": AnyEncodable(name),
      "calories": AnyEncodable(Double(calories) ?? 0),
      "protein": AnyEncodable(Double(protein) ?? 0),
      "carbs": AnyEncodable(Double(carbs) ?? 0),
      "fat": AnyEncodable(Double(fat) ?? 0),
      "note": AnyEncodable(note),
      "photo": AnyEncodable(photo),
      "date": AnyEncodable(date),
      "time": AnyEncodable(time),
    ]
  }
}

struct RoundSetBody: Encodable {
  var id: String
  var weightLb: Double
  var reps: Double
}

struct AnyEncodable: Encodable {
  private let encodeFunc: (Encoder) throws -> Void
  init<T: Encodable>(_ value: T) { encodeFunc = value.encode }
  func encode(to encoder: Encoder) throws { try encodeFunc(encoder) }
}

struct LoginResponse: Codable {
  var ok: Bool
  var token: String
}

struct OkResponse: Codable {
  var ok: Bool
}

struct APIErrorBody: Codable {
  var error: String?
}
