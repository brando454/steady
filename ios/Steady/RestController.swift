import ActivityKit
import AVFoundation
import Foundation
import UIKit
import UserNotifications

@MainActor
final class RestController: NSObject, UNUserNotificationCenterDelegate {
  private var player: AVAudioPlayer?
  private let haptic = UINotificationFeedbackGenerator()
  private var cueTask: Task<Void, Never>?
  /// Set when this rest's ding and haptic have already fired, so the in-app
  /// player and the foreground notification cannot both play.
  private var cued = false

  private var headline = ""
  private var detail = ""
  private var shortName = ""

  func start(name: String, seconds: Int, detail next: String, shortName nameShort: String) async -> (ends: Date, planned: Int, allowed: Bool) {
    let planned = max(15, seconds)
    let ends = Date().addingTimeInterval(TimeInterval(planned))
    headline = name
    detail = next
    shortName = nameShort
    let allowed = await ensurePermission()
    schedule(name: name, at: ends)
    armForegroundCue(at: ends)
    await show(ends: ends, planned: planned)
    return (ends, planned, allowed)
  }

  func shift(name: String, ends: Date?, by seconds: Int, planned: Int) async -> (ends: Date, planned: Int) {
    let base = max(ends ?? Date(), Date())
    var next = base.addingTimeInterval(TimeInterval(seconds))
    if next < Date().addingTimeInterval(1) { next = Date().addingTimeInterval(1) }
    let span = max(planned, Int(next.timeIntervalSinceNow.rounded(.up)))
    if !name.isEmpty { headline = name }
    schedule(name: headline, at: next)
    armForegroundCue(at: next)
    await show(ends: next, planned: span)
    return (next, span)
  }

  /// Updates the Live Activity without touching the rest notification.
  func show(headline: String, detail: String, shortName: String, ends: Date?, planned: Int) async {
    self.headline = headline
    self.detail = detail
    self.shortName = shortName
    await show(ends: ends, planned: max(planned, 1))
  }

  /// Stops the ding and countdown, and leaves the activity on the next set.
  func endCountdown() {
    cueTask?.cancel()
    cueTask = nil
    cued = false
    player?.stop()
    player = nil
    UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ["steady.rest"])
  }

  func stop() {
    endCountdown()
    headline = ""
    detail = ""
    shortName = ""
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
    guard notification.request.identifier == "steady.rest" else {
      return [.banner, .sound, .list]
    }
    // Foreground: the banner stays. The ding and the success haptic happen
    // once, either here or in the in-app cue, whichever runs first.
    if cued { return [.banner, .list] }
    cued = true
    haptic.prepare()
    haptic.notificationOccurred(.success)
    return [.banner, .sound, .list]
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
    content.sound = UNNotificationSound(named: UNNotificationSoundName("rest-done.wav"))
    let trigger = UNCalendarNotificationTrigger(
      dateMatching: Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date),
      repeats: false
    )
    let request = UNNotificationRequest(identifier: "steady.rest", content: content, trigger: trigger)
    let center = UNUserNotificationCenter.current()
    center.removePendingNotificationRequests(withIdentifiers: ["steady.rest"])
    center.add(request)
  }

  /// Plays the ding only when the phone is open and the notification will not.
  /// Background and the lock screen leave the sound and vibration to the system.
  private func armForegroundCue(at date: Date) {
    cueTask?.cancel()
    cued = false
    haptic.prepare()
    cueTask = Task { @MainActor in
      let delay = date.timeIntervalSinceNow
      if delay > 0 {
        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
      }
      guard !Task.isCancelled else { return }
      guard UIApplication.shared.applicationState == .active else { return }
      let settings = await UNUserNotificationCenter.current().notificationSettings()
      guard !Task.isCancelled else { return }
      switch settings.authorizationStatus {
      case .authorized, .provisional, .ephemeral:
        return
      default:
        playDingAndHaptic()
      }
    }
  }

  private func playDingAndHaptic() {
    guard !cued else { return }
    cued = true
    haptic.prepare()
    haptic.notificationOccurred(.success)
    guard let url = Bundle.main.url(forResource: "rest-done", withExtension: "wav") else { return }
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.ambient, options: [.mixWithOthers])
    try? session.setActive(true)
    player = try? AVAudioPlayer(contentsOf: url)
    player?.prepareToPlay()
    player?.play()
  }

  private func show(ends: Date?, planned: Int) async {
    let state = RestAttributes.ContentState(
      endsAt: ends,
      headline: headline,
      detail: detail,
      shortName: shortName,
      plannedSeconds: max(planned, 1)
    )
    let content = ActivityContent(state: state, staleDate: ends?.addingTimeInterval(30))
    if let current = Activity<RestAttributes>.activities.first {
      await current.update(content)
      return
    }
    guard !headline.isEmpty else { return }
    let attributes = RestAttributes(exerciseName: shortName.isEmpty ? headline : shortName, plannedSeconds: max(planned, 1))
    _ = try? Activity.request(attributes: attributes, content: content, pushType: nil)
  }
}
