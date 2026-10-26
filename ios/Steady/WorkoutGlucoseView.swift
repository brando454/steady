import SwiftUI

struct WorkoutGlucoseSummary: View {
  var summary: WorkoutGlucose

  var body: some View {
    if summary.unavailable && !summary.inProgress {
      Text("Glucose unavailable")
        .font(.system(size: 13))
        .foregroundStyle(Theme.muted)
    } else {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Text("Glucose")
            .font(.system(size: 13))
            .foregroundStyle(Theme.muted)
          Spacer()
          if summary.inProgress {
            Text("In progress")
              .font(.system(size: 13))
              .foregroundStyle(Theme.muted)
          }
        }
        sparkline
        HStack(alignment: .bottom, spacing: 8) {
          stat("Start", summary.startMgdl)
          stat("End", summary.endMgdl)
          stat("Avg", summary.averageMgdl)
          stat("Low", summary.lowDuringMgdl)
          afterStat
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(label)
    }
  }

  private var label: String {
    func n(_ value: Int?) -> String { value == nil ? "missing" : "\(value ?? 0) mg/dL" }
    let state = summary.unavailable ? "unavailable" : (summary.inProgress ? "in progress" : "complete")
    return "Workout glucose \(state). Start \(n(summary.startMgdl)), end \(n(summary.endMgdl)), average \(n(summary.averageMgdl)), lowest during \(n(summary.lowDuringMgdl)), lowest in the two hours after \(n(summary.lowAfterMgdl))."
  }

  @ViewBuilder private var sparkline: some View {
    if !summary.points.isEmpty && summary.windowMinutes > 0 {
      Canvas { context, size in
        let values = summary.points.map { Double($0.mgdl) }
        let minV = values.min() ?? 0
        let maxV = values.max() ?? 1
        let pad = max(8, (maxV - minV) * 0.2)
        let yMin = minV - pad
        let yMax = max(maxV + pad, yMin + 1)
        func x(_ minute: Double) -> CGFloat {
          CGFloat(min(1, max(0, minute / summary.windowMinutes))) * size.width
        }
        func y(_ mgdl: Double) -> CGFloat {
          let t = (mgdl - yMin) / (yMax - yMin)
          return 2 + (1 - t) * (size.height - 4)
        }
        let shade = Path(CGRect(x: 0, y: 0, width: x(summary.workoutMinutes), height: size.height))
        context.fill(shade, with: .color(Theme.accent.opacity(0.16)))
        for group in groups(summary.points) {
          if group.count == 1, let point = group.first {
            let rect = CGRect(x: x(point.minute) - 2.2, y: y(Double(point.mgdl)) - 2.2, width: 4.4, height: 4.4)
            context.fill(Path(ellipseIn: rect), with: .color(Theme.text))
          } else {
            var path = Path()
            for (index, point) in group.enumerated() {
              let spot = CGPoint(x: x(point.minute), y: y(Double(point.mgdl)))
              if index == 0 { path.move(to: spot) } else { path.addLine(to: spot) }
            }
            context.stroke(path, with: .color(Theme.text), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
          }
        }
      }
      .frame(height: 36)
      .accessibilityHidden(true)
    }
  }

  private func stat(_ title: String, _ value: Int?) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title).font(.system(size: 11)).foregroundStyle(Theme.muted)
      Text(value == nil ? "—" : "\(value ?? 0)")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Theme.text)
        .monospacedDigit()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var afterStat: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text("2h low").font(.system(size: 11)).foregroundStyle(Theme.muted)
      if let value = summary.lowAfterMgdl {
        Text("\(value)")
          .font(.system(size: 15, weight: .semibold))
          .monospacedDigit()
          .foregroundStyle(tone(value))
          .padding(.horizontal, 8)
          .padding(.vertical, 2)
          .background(tone(value).opacity(value < 120 || value > 180 ? 0.22 : 0.12), in: Capsule())
      } else {
        Text("—")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(Theme.text)
      }
    }
    .fixedSize()
  }

  private func tone(_ value: Int) -> Color {
    if value < 120 { return Theme.warn }
    if value > 180 { return Theme.danger }
    return Theme.text
  }

  private func groups(_ points: [WorkoutGlucosePoint]) -> [[WorkoutGlucosePoint]] {
    let sorted = points.sorted { $0.minute < $1.minute }
    var groups: [[WorkoutGlucosePoint]] = []
    var current: [WorkoutGlucosePoint] = []
    for point in sorted {
      if let previous = current.last, point.minute - previous.minute > 12 {
        groups.append(current)
        current = []
      }
      current.append(point)
    }
    if !current.isEmpty { groups.append(current) }
    return groups
  }
}
