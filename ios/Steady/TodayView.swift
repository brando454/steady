import SwiftUI
import UIKit

struct TodayView: View {
  @EnvironmentObject private var model: AppModel
  @State private var showSettings = false

  var body: some View {
    ScreenStack {
      HStack {
        Text(model.today?.dateLabel ?? "")
          .font(.system(size: 15, weight: .regular))
          .foregroundStyle(Theme.muted)
        Spacer()
        QuietButton(title: "Settings") { showSettings = true }
      }
      Text(model.today?.greeting ?? "Today")
        .font(.system(size: 20, weight: .semibold))
        .foregroundStyle(Theme.text)
      BannerText(text: model.banner)
      if let today = model.today {
        Card {
          HStack(alignment: .center, spacing: 16) {
            CalorieRing(eaten: today.totals.calories, target: today.targets.calories, left: today.left.calories)
            MacroBars(
              protein: (today.totals.protein, today.targets.protein),
              carbs: (today.totals.carbs, today.targets.carbs),
              fat: (today.totals.fat, today.targets.fat)
            )
          }
        }
        if let suggestion = today.suggestion {
          if suggestion.completedToday {
            CompletedTodayCard(suggestion: suggestion) {
              if let id = suggestion.sessionId { model.showFinishedWorkout(id) }
            }
          } else {
            Card {
              Text(suggestion.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
              if let note = suggestion.rampNote, !note.isEmpty {
                Text(note).font(.system(size: 13)).foregroundStyle(Theme.muted)
              }
              Text(suggestion.summary).font(.system(size: 13)).foregroundStyle(Theme.muted)
              PrimaryButton(title: startLabel(suggestion), enabled: !model.busy) {
                model.startDay(suggestion.dayId)
              }
            }
          }
        } else {
          Card {
            Text("All five days are done.").font(.system(size: 15, weight: .semibold))
            QuietButton(title: "This week") { model.tab = .workout }
          }
        }
        Card {
          Text("Meals").font(.system(size: 15, weight: .semibold))
          if today.meals.isEmpty {
            Text("No meals yet.").font(.system(size: 13)).foregroundStyle(Theme.muted)
          }
          ForEach(today.meals) { meal in
            HStack {
              VStack(alignment: .leading, spacing: 2) {
                Text(meal.name).font(.system(size: 15, weight: .regular))
                Text(meal.timeLabel).font(.system(size: 12)).foregroundStyle(Theme.muted)
              }
              Spacer()
              Text("\(Format.grouped(meal.calories)) kcal")
                .font(.system(size: 13, weight: .light))
                .foregroundStyle(Theme.muted)
            }
          }
        }
      } else {
        Text("Loading today…").font(.system(size: 15)).foregroundStyle(Theme.muted)
      }
    }
    .sheet(isPresented: $showSettings) { SettingsView() }
  }

  private func startLabel(_ suggestion: TodaySuggestion) -> String {
    if suggestion.status == "in_progress" { return "Resume workout" }
    return "Start workout"
  }
}

private struct CompletedTodayCard: View {
  var suggestion: TodaySuggestion
  var open: () -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var celebrate = false
  @State private var burst = false

  var body: some View {
    Card {
      HStack(alignment: .center, spacing: 12) {
        ZStack {
          Circle().fill(Theme.accentSoft).frame(width: 36, height: 36)
          Image(systemName: "checkmark")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Theme.ok)
          if celebrate {
            ForEach(DaySpark.all) { spark in
              Circle()
                .fill(spark.color)
                .frame(width: 5, height: 5)
                .offset(burst ? spark.away : .zero)
                .opacity(burst ? 0 : 1)
            }
          }
        }
        .scaleEffect(celebrate && !burst ? 0.86 : 1)
        VStack(alignment: .leading, spacing: 2) {
          Text("Day done")
            .font(.system(size: 12))
            .foregroundStyle(Theme.muted)
          Text(suggestion.name)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(Theme.text)
        }
        Spacer(minLength: 0)
      }
      if !suggestion.resultLine.isEmpty {
        Text(suggestion.resultLine)
          .font(.system(size: 13))
          .foregroundStyle(Theme.muted)
      }
      if let glucose = suggestion.glucose {
        WorkoutGlucoseSummary(summary: glucose)
      }
      if !suggestion.summary.isEmpty {
        Text(suggestion.summary)
          .font(.system(size: 13))
          .foregroundStyle(Theme.muted)
      }
      if suggestion.sessionId != nil {
        Button("View workout", action: open)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(Theme.accent)
      }
    }
    .onAppear(perform: playOnce)
  }

  private func playOnce() {
    guard suggestion.completedToday, let id = suggestion.sessionId else { return }
    let key = "steady-day-done-\(id)"
    let seen = UserDefaults.standard.bool(forKey: key)
    if !seen { UserDefaults.standard.set(true, forKey: key) }
    guard !seen, !reduceMotion else { return }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    celebrate = true
    DispatchQueue.main.async {
      withAnimation(.easeOut(duration: 0.7)) { burst = true }
    }
  }
}

private struct DaySpark: Identifiable {
  var id: Int
  var away: CGSize
  var color: Color
  static let all: [DaySpark] = [
    DaySpark(id: 0, away: CGSize(width: -16, height: -14), color: Theme.accent),
    DaySpark(id: 1, away: CGSize(width: 14, height: -16), color: Theme.ok),
    DaySpark(id: 2, away: CGSize(width: 18, height: 4), color: Theme.accent),
    DaySpark(id: 3, away: CGSize(width: -18, height: 6), color: Theme.warn),
    DaySpark(id: 4, away: CGSize(width: 6, height: 16), color: Theme.ok),
    DaySpark(id: 5, away: CGSize(width: -6, height: -18), color: Theme.accent),
  ]
}
