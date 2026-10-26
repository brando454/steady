import SwiftUI
import WidgetKit

struct SteadyEntry: TimelineEntry {
  var date: Date
  var snapshot: WidgetSnapshot?
}

struct SteadyProvider: TimelineProvider {
  func placeholder(in context: Context) -> SteadyEntry {
    SteadyEntry(date: Date(), snapshot: .sample)
  }

  func getSnapshot(in context: Context, completion: @escaping (SteadyEntry) -> Void) {
    if context.isPreview {
      completion(SteadyEntry(date: Date(), snapshot: .sample))
      return
    }
    completion(SteadyEntry(date: Date(), snapshot: AppGroup.loadSnapshot()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<SteadyEntry>) -> Void) {
    Task {
      let snapshot = await WidgetTodayLoader.load()
      let entry = SteadyEntry(date: Date(), snapshot: snapshot)
      let next = Date().addingTimeInterval(30 * 60)
      completion(Timeline(entries: [entry], policy: .after(next)))
    }
  }
}

enum WidgetTodayLoader {
  private static let root = "https://steady-re7n.onrender.com"

  static func load() async -> WidgetSnapshot? {
    let cached = AppGroup.loadSnapshot()
    guard let token = AppGroup.token(), let url = URL(string: "\(root)/api/today") else { return cached }
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.timeoutInterval = 8
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    guard
      let (data, response) = try? await URLSession.shared.data(for: request),
      let http = response as? HTTPURLResponse,
      http.statusCode == 200,
      let payload = try? JSONDecoder().decode(WidgetTodayPayload.self, from: data)
    else {
      return cached
    }
    let snapshot = WidgetSnapshot(
      date: payload.date,
      updatedAt: Date(),
      caloriesEaten: payload.totals.calories,
      caloriesTarget: payload.targets.calories,
      caloriesLeft: payload.left.calories,
      proteinEaten: payload.totals.protein,
      proteinTarget: payload.targets.protein,
      carbsEaten: payload.totals.carbs,
      carbsTarget: payload.targets.carbs,
      fatEaten: payload.totals.fat,
      fatTarget: payload.targets.fat
    )
    AppGroup.saveSnapshot(snapshot)
    return snapshot
  }
}

private struct WidgetTodayPayload: Decodable {
  var date: String
  var targets: Macros
  var totals: Macros
  var left: Macros

  struct Macros: Decodable {
    var calories: Double
    var protein: Double
    var carbs: Double
    var fat: Double
  }
}

extension WidgetSnapshot {
  static let sample = WidgetSnapshot(
    date: "Today",
    updatedAt: Date(),
    caloriesEaten: 1200,
    caloriesTarget: 3000,
    caloriesLeft: 1800,
    proteinEaten: 80,
    proteinTarget: 190,
    carbsEaten: 90,
    carbsTarget: 330,
    fatEaten: 30,
    fatTarget: 85
  )
}

struct SteadyHomeWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "SteadyToday", provider: SteadyProvider()) { entry in
      SteadyWidgetView(entry: entry)
    }
    .configurationDisplayName("Steady")
    .description("Today's calories and macros. Tap to log food.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct SteadyWidgetView: View {
  var entry: SteadyEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    Group {
      if let snapshot = entry.snapshot {
        if family == .systemSmall {
          small(snapshot)
        } else {
          medium(snapshot)
        }
      } else {
        Text("Open Steady")
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(Theme.text)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      }
    }
    .containerBackground(Theme.card, for: .widget)
    .widgetURL(URL(string: "steady://food"))
  }

  private func small(_ snapshot: WidgetSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("\(Format.grouped(snapshot.caloriesLeft))")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(Theme.text)
        .monospacedDigit()
      Text(snapshot.caloriesLeft < 0 ? "kcal over" : "kcal left")
        .font(.system(size: 12))
        .foregroundStyle(Theme.muted)
      Spacer(minLength: 0)
      MacroLine(name: "Protein", eaten: snapshot.proteinEaten, target: snapshot.proteinTarget)
    }
  }

  private func medium(_ snapshot: WidgetSnapshot) -> some View {
    HStack(alignment: .center, spacing: 14) {
      VStack(alignment: .leading, spacing: 2) {
        Text("\(Format.grouped(snapshot.caloriesLeft))")
          .font(.system(size: 28, weight: .semibold))
          .foregroundStyle(Theme.text)
          .monospacedDigit()
        Text(snapshot.caloriesLeft < 0 ? "kcal over" : "kcal left")
          .font(.system(size: 12))
          .foregroundStyle(Theme.muted)
        Text(Boise.updatedLine(snapshot.updatedAt))
          .font(.system(size: 11))
          .foregroundStyle(Theme.foot)
      }
      VStack(alignment: .leading, spacing: 8) {
        MacroLine(name: "Protein", eaten: snapshot.proteinEaten, target: snapshot.proteinTarget)
        MacroLine(name: "Carbs", eaten: snapshot.carbsEaten, target: snapshot.carbsTarget)
        MacroLine(name: "Fat", eaten: snapshot.fatEaten, target: snapshot.fatTarget)
      }
    }
  }
}

private struct MacroLine: View {
  var name: String
  var eaten: Double
  var target: Double

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack {
        Text(name)
        Spacer(minLength: 4)
        Text("\(Int(eaten.rounded()))/\(Int(target.rounded()))")
      }
      .font(.system(size: 11))
      .foregroundStyle(Theme.muted)
      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule().fill(Theme.fill)
          Capsule().fill(Theme.accent).frame(width: geo.size.width * fraction)
        }
      }
      .frame(height: 6)
    }
  }

  private var fraction: CGFloat {
    guard target > 0 else { return 0 }
    return CGFloat(min(1, max(0, eaten / target)))
  }
}

struct RestLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: RestAttributes.self) { context in
      VStack(alignment: .leading, spacing: 4) {
        Text(context.attributes.exerciseName)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(Theme.text)
        Text(timerInterval: RestClock.range(endsAt: context.state.endsAt, plannedSeconds: context.attributes.plannedSeconds), countsDown: true)
          .font(.system(size: 22, weight: .semibold))
          .monospacedDigit()
          .foregroundStyle(Theme.accent)
        Text("Rest")
          .font(.system(size: 12))
          .foregroundStyle(Theme.muted)
      }
      .padding(14)
      .activityBackgroundTint(Theme.card)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Text(context.attributes.exerciseName)
            .font(.system(size: 13, weight: .semibold))
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(timerInterval: RestClock.range(endsAt: context.state.endsAt, plannedSeconds: context.attributes.plannedSeconds), countsDown: true)
            .monospacedDigit()
            .font(.system(size: 15, weight: .semibold))
        }
      } compactLeading: {
        Image(systemName: "timer")
      } compactTrailing: {
        Text(timerInterval: RestClock.range(endsAt: context.state.endsAt, plannedSeconds: context.attributes.plannedSeconds), countsDown: true)
          .monospacedDigit()
          .frame(width: 44)
      } minimal: {
        Image(systemName: "timer")
      }
    }
  }
}

@main
struct SteadyWidgets: WidgetBundle {
  var body: some Widget {
    SteadyHomeWidget()
    RestLiveActivity()
  }
}
