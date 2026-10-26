import SwiftUI

struct WorkoutView: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    NavigationStack(path: $model.workoutPath) {
      ScreenStack {
        Text("This week")
          .font(.system(size: 20, weight: .semibold))
          .foregroundStyle(Theme.text)
        if let week = model.week {
          Text("\(week.doneCount) of \(week.total) done")
            .font(.system(size: 13))
            .foregroundStyle(Theme.muted)
          Text(week.rangeLabel).font(.system(size: 13)).foregroundStyle(Theme.muted)
          if let note = week.rampNote, !note.isEmpty {
            Text(note).font(.system(size: 13)).foregroundStyle(Theme.warn)
          }
          BannerText(text: model.banner)
          ForEach(week.days) { day in
            NavigationLink(value: WorkoutRoute.day(day.id)) {
              Card {
                HStack {
                  VStack(alignment: .leading, spacing: 4) {
                    Text(day.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                    Text(day.summary).font(.system(size: 13)).foregroundStyle(Theme.muted)
                  }
                  Spacer()
                  Text(dayLabel(day))
                    .font(.system(size: 12, weight: .regular))
                    .foregroundStyle(Theme.muted)
                }
              }
            }
            .buttonStyle(.plain)
            .id(day.id)
          }
          NavigationLink(value: WorkoutRoute.history) {
            Text("History")
              .font(.system(size: 14, weight: .semibold))
              .foregroundStyle(Theme.accent)
              .frame(minHeight: 36)
          }
        } else {
          Text("Loading the week…").foregroundStyle(Theme.muted)
        }
      }
      .navigationDestination(for: WorkoutRoute.self) { route in
        switch route {
        case .day(let id): DayDetailView(dayId: id)
        case .session(let id): SessionView(sessionId: id)
        case .history: HistoryListView()
        case .exercise(let id): ExerciseHistoryView(exerciseId: id)
        case .settings: SettingsView()
        }
      }
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(.hidden, for: .navigationBar)
    }
  }

  private func dayLabel(_ day: DayPlan) -> String {
    if day.status == "done" { return day.doneWeekday.map { "Done \($0)" } ?? "Done" }
    if day.status == "in_progress" { return "In progress" }
    if day.suggested { return "Up next" }
    return "Ready"
  }
}

struct DayDetailView: View {
  @EnvironmentObject private var model: AppModel
  var dayId: String

  var body: some View {
    ScreenStack {
      QuietButton(title: "This week") { model.workoutPath.removeLast() }
      if let day = model.week?.days.first(where: { $0.id == dayId }) {
        Text(day.suggested ? "Up next" : (day.status == "done" ? "Done" : "This week"))
          .font(.system(size: 13)).foregroundStyle(Theme.muted)
        Text(day.name).font(.system(size: 20, weight: .semibold))
        Text(day.summary).font(.system(size: 13)).foregroundStyle(Theme.muted)
        if let note = model.week?.rampNote { Text(note).font(.system(size: 13)).foregroundStyle(Theme.warn) }
        Card {
          ForEach(Array(day.exercises.enumerated()), id: \.offset) { _, exercise in
            VStack(alignment: .leading, spacing: 2) {
              Text(exercise.name).font(.system(size: 15, weight: .semibold))
              Text(exercise.detail).font(.system(size: 13)).foregroundStyle(Theme.muted)
            }
          }
        }
        PrimaryButton(
          title: day.status == "in_progress" ? "Resume workout" : (day.status == "done" ? "Start again" : "Start workout"),
          enabled: !model.busy
        ) {
          model.remember(key: "/workout", anchor: day.id)
          model.startDay(day.id)
        }
      } else {
        Text("That day isn't in this week.")
      }
      BannerText(text: model.banner)
    }
    .toolbar(.hidden, for: .navigationBar)
  }
}

struct HistoryListView: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    ScreenStack {
      QuietButton(title: "This week") { model.workoutPath.removeLast() }
      Text("History").font(.system(size: 20, weight: .semibold))
      if let history = model.history {
        if history.isEmpty { Text("No workouts yet.").foregroundStyle(Theme.muted) }
        ForEach(history) { item in
          Card {
            HStack {
              VStack(alignment: .leading, spacing: 2) {
                Text(item.name).font(.system(size: 15, weight: .semibold))
                Text("\(item.weekday) · \(item.dateLabel)").font(.system(size: 13)).foregroundStyle(Theme.muted)
              }
              Spacer()
              VStack(alignment: .trailing, spacing: 2) {
                Text(item.durationLabel).font(.system(size: 13)).foregroundStyle(Theme.muted)
                if item.prCount > 0 {
                  Text("\(item.prCount) PR").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ok)
                }
              }
            }
          }
        }
      } else {
        Text("Loading history…").foregroundStyle(Theme.muted)
      }
    }
    .task { await model.loadHistory() }
    .toolbar(.hidden, for: .navigationBar)
  }
}

struct ExerciseHistoryView: View {
  @EnvironmentObject private var model: AppModel
  var exerciseId: String

  var body: some View {
    ScreenStack {
      QuietButton(title: "Back") { model.workoutPath.removeLast() }
      if let page = model.exercisePage, page.id == exerciseId {
        Text(page.name).font(.system(size: 20, weight: .semibold))
        if let best = page.best {
          Text("Best \(best.label)").font(.system(size: 13)).foregroundStyle(Theme.muted)
        }
        Text(page.chartLabel).font(.system(size: 12)).foregroundStyle(Theme.muted)
        TrendChart(
          points: page.series.map { (date: $0.date, dot: Optional($0.value), line: Optional($0.value)) },
          target: nil
        )
        .frame(height: 140)
        ForEach(page.sessions) { past in
          Card {
            Text(past.dateLabel).font(.system(size: 13)).foregroundStyle(Theme.muted)
            Text(past.workoutName).font(.system(size: 15, weight: .semibold))
            ForEach(Array(past.sets.enumerated()), id: \.offset) { _, set in
              HStack {
                Text(set.label).font(.system(size: 13))
                if set.isPr {
                  Text("PR").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.ok)
                }
              }
            }
          }
        }
      } else {
        Text("Loading…").foregroundStyle(Theme.muted)
      }
      BannerText(text: model.banner)
    }
    .task { await model.loadExercise(exerciseId) }
    .toolbar(.hidden, for: .navigationBar)
  }
}
