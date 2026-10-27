import SwiftUI
import UIKit

enum Theme {
  static let bg = adaptive(0xEEF2F6, 0x0E141B)
  static let card = adaptive(0xFFFFFF, 0x18222E)
  static let text = adaptive(0x1A2332, 0xE7EEF6)
  static let muted = adaptive(0x3E4C5E, 0xA8B6C6)
  static let line = adaptive(0xD5DEE8, 0x2C3B4C)
  static let accent = adaptive(0x1F5BD8, 0x8EB6FF)
  static let accentSoft = adaptive(0xE7EFFF, 0x1C2C44)
  static let onAccent = adaptive(0xFFFFFF, 0x0E141B)
  static let fill = adaptive(0xE6EDF5, 0x243140)
  static let ok = adaptive(0x0D6B40, 0x8EE0B5)
  static let danger = adaptive(0x9D2C22, 0xFFB4AB)
  static let warn = adaptive(0x8A5600, 0xF0C27A)
  static let foot = adaptive(0x8A97A8, 0x7D8B9C)
  static let accentUI = UIColor { traits in UIColor(hex: traits.userInterfaceStyle == .dark ? 0x8EB6FF : 0x1F5BD8) }
  static let onAccentUI = UIColor { traits in UIColor(hex: traits.userInterfaceStyle == .dark ? 0x0E141B : 0xFFFFFF) }

  private static func adaptive(_ light: UInt, _ dark: UInt) -> Color {
    Color(uiColor: UIColor { traits in
      UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
    })
  }
}

extension UIColor {
  convenience init(hex: UInt) {
    self.init(
      red: CGFloat((hex >> 16) & 0xFF) / 255,
      green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255,
      alpha: 1
    )
  }
}

enum Format {
  static func grouped(_ value: Double) -> String {
    let number = Int(abs(value).rounded())
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    formatter.groupingSeparator = ","
    return formatter.string(from: NSNumber(value: number)) ?? "\(number)"
  }

  static func qty(_ value: Double) -> String {
    let rounded = (value * 10).rounded() / 10
    if abs(rounded - rounded.rounded()) < 0.001 {
      return String(Int(rounded.rounded()))
    }
    return String(format: "%.1f", rounded)
  }

  static func qty(_ value: Double?) -> String {
    guard let value else { return "" }
    return qty(value)
  }

  static func clock(_ seconds: Int) -> String {
    let safe = max(0, seconds)
    return String(format: "%d:%02d", safe / 60, safe % 60)
  }

  static func performance(weight: Double?, reps: Double?, measure: String, perSide: Bool) -> String {
    if measure == "cardio" { return "Cardio" }
    let side = perSide ? " / side" : ""
    if measure == "meters" {
      let load = (weight ?? 0) > 0 ? "\(qty(weight ?? 0)) lb" : "Bodyweight"
      let distance = reps == nil ? "—" : "\(qty(reps ?? 0)) m"
      return "\(load) × \(distance)"
    }
    if (weight ?? 0) <= 0 {
      guard let reps else { return "—" }
      return "\(qty(reps)) reps\(side)"
    }
    let repsText = reps == nil ? "—" : qty(reps ?? 0)
    return "\(qty(weight ?? 0)) lb × \(repsText)\(side)"
  }
}

enum Boise {
  static let zone = TimeZone(identifier: "America/Boise") ?? TimeZone(secondsFromGMT: -6 * 3600)!

  static func civil(_ date: Date = Date()) -> String {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.timeZone = zone
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
  }

  static func weekStart(_ civilDate: String) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    let formatter = DateFormatter()
    formatter.calendar = calendar
    formatter.timeZone = zone
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd"
    guard let date = formatter.date(from: civilDate) else { return civilDate }
    let weekday = calendar.component(.weekday, from: date)
    let sinceMonday = (weekday + 5) % 7
    let start = calendar.date(byAdding: .day, value: -sinceMonday, to: date) ?? date
    return formatter.string(from: start)
  }

  static func hour(_ date: Date = Date()) -> Int {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    return calendar.component(.hour, from: date)
  }

  static func nextMidnight(after date: Date = Date()) -> Date {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    let start = calendar.startOfDay(for: date)
    return calendar.date(byAdding: .day, value: 1, to: start) ?? date.addingTimeInterval(24 * 60 * 60)
  }

  static func timeValue(_ date: Date = Date()) -> String {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.timeZone = zone
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "HH:mm"
    return formatter.string(from: date)
  }

  static func updatedLine(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.timeZone = zone
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "h:mm a"
    return "Updated \(formatter.string(from: date))"
  }
}
