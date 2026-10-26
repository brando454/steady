import Foundation

struct WidgetSnapshot: Codable, Equatable {
  var date: String
  var updatedAt: Date
  var caloriesEaten: Double
  var caloriesTarget: Double
  var caloriesLeft: Double
  var proteinEaten: Double
  var proteinTarget: Double
  var carbsEaten: Double
  var carbsTarget: Double
  var fatEaten: Double
  var fatTarget: Double

  var proteinFraction: Double { fraction(proteinEaten, proteinTarget) }
  var carbsFraction: Double { fraction(carbsEaten, carbsTarget) }
  var fatFraction: Double { fraction(fatEaten, fatTarget) }
  var calorieFraction: Double { fraction(caloriesEaten, caloriesTarget) }

  private func fraction(_ eaten: Double, _ target: Double) -> Double {
    guard target > 0 else { return 0 }
    return min(1, max(0, eaten / target))
  }
}

enum AppGroup {
  static let id = "group.com.brando454.steady"
  private static let snapshotKey = "widget.snapshot"
  private static let tokenKey = "session.token"

  static var defaults: UserDefaults {
    UserDefaults(suiteName: id) ?? .standard
  }

  static func saveSnapshot(_ snapshot: WidgetSnapshot) {
    guard let data = try? JSONEncoder().encode(snapshot) else { return }
    defaults.set(data, forKey: snapshotKey)
  }

  static func loadSnapshot() -> WidgetSnapshot? {
    guard let data = defaults.data(forKey: snapshotKey) else { return nil }
    return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
  }

  static func saveToken(_ token: String) {
    defaults.set(token, forKey: tokenKey)
  }

  static func token() -> String? {
    let value = defaults.string(forKey: tokenKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
    return value?.isEmpty == false ? value : nil
  }

  static func clearToken() {
    defaults.removeObject(forKey: tokenKey)
  }
}
