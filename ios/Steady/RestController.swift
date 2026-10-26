import ActivityKit
import Foundation
import UserNotifications

@MainActor
final class RestController: NSObject, UNUserNotificationCenterDelegate {
  func start(name: String, seconds: Int) async -> (ends: Date, planned: Int, allowed: Bool) {
    let planned = max(15, seconds)
    let ends = Date().addingTimeInterval(TimeInterval(planned))
    let allowed = await ensurePermission()
    schedule(name: name, at: ends)
    await upsert(name: name, ends: ends, planned: planned)
    return (ends, planned, allowed)
  }

  func shift(name: String, ends: Date?, by seconds: Int, planned: Int) async -> (ends: Date, planned: Int) {
    let base = max(ends ?? Date(), Date())
    var next = base.addingTimeInterval(TimeInterval(seconds))
    if next < Date().addingTimeInterval(1) { next = Date().addingTimeInterval(1) }
    let span = max(planned, Int(next.timeIntervalSinceNow.rounded(.up)))
    schedule(name: name, at: next)
    await upsert(name: name, ends: next, planned: span)
    return (next, span)
  }

  func stop() {
    UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ["steady.rest"])
    Task {
      for activity in Activity<RestAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .sound, .list]
  }

  private func ensurePermission() async -> Bool {
    let center = UNUserNotificationCenter.current()
    var settings = await center.notificationSettings()
    if settings.authorizationStatus == .notDetermined {
      _ = try? await center.requestAuthorization(options: [.alert, .sound])
      settings = await center.notificationSettings()
    }
    switch settings.authorizationStatus {
    case .authorized, .provisional, .ephemeral: return true
    default: return false
    }
  }

  private func schedule(name: String, at date: Date) {
    let content = UNMutableNotificationContent()
    content.title = "Rest done"
    content.body = name.isEmpty ? "Time for the next set." : name
    content.sound = .default
    let trigger = UNCalendarNotificationTrigger(
      dateMatching: Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date),
      repeats: false
    )
    let request = UNNotificationRequest(identifier: "steady.rest", content: content, trigger: trigger)
    let center = UNUserNotificationCenter.current()
    center.removePendingNotificationRequests(withIdentifiers: ["steady.rest"])
    center.add(request)
  }

  private func upsert(name: String, ends: Date, planned: Int) async {
    let state = RestAttributes.ContentState(endsAt: ends)
    let content = ActivityContent(state: state, staleDate: ends.addingTimeInterval(30))
    if let current = Activity<RestAttributes>.activities.first {
      await current.update(content)
      return
    }
    let attributes = RestAttributes(exerciseName: name, plannedSeconds: planned)
    _ = try? Activity.request(attributes: attributes, content: content, pushType: nil)
  }
}
