import SwiftUI

struct MealGlucoseCard: View {
  var summary: MealGlucose
  @State private var open = false

  var body: some View {
    if summary.unavailable || (summary.points.isEmpty && summary.atMgdl == nil && summary.peakMgdl == nil) {
      Text(line)
        .font(.system(size: 13))
        .foregroundStyle(Theme.muted)
    } else {
      VStack(alignment: .leading, spacing: 8) {
        Button {
          open.toggle()
        } label: {
          Text(line)
            .font(.system(size: 13, weight: .regular))
            .foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        if open {
          sparkline
          HStack(alignment: .top, spacing: 8) {
            stat("At meal", summary.atMgdl.map(String.init) ?? "—", nil)
            stat("Peak", summary.peakMgdl.map(String.init) ?? "—", summary.peakMinute.map { "\($0) min" })
            stat("Rise", riseText, nil)
            lowStat
          }
        }
      }
    }
  }

  private var line: String {
    if summary.unavailable { return "Glucose unavailable" }
    if summary.atMgdl == nil && summary.peakMgdl == nil {
      return summary.inProgress ? "Glucose in progress" : "No glucose yet"
    }
    let at = summary.atMgdl.map(String.init) ?? "—"
    let peak = summary.peakMgdl.map(String.init) ?? "—"
    let rise: String
    if let value = summary.riseMgdl {
      rise = value > 0 ? " · +\(value)" : " · \(value)"
    } else {
      rise = ""
    }
    let state = summary.inProgress ? " · in progress" : ""
    return "\(at) → \(peak)\(rise)\(state)"
  }

  private var riseText: String {
    guard let value = summary.riseMgdl else { return "—" }
    return value > 0 ? "+\(value)" : "\(value)"
  }

  private var sparkline: some View {
    Canvas { context, size in
      let span = 210.0
      let values = summary.points.map { Double($0.mgdl) }
      let minV = values.min() ?? 80
      let maxV = values.max() ?? 180
      let pad = max(8, (maxV - minV) * 0.2)
      let yMin = minV - pad
      let yMax = max(maxV + pad, yMin + 1)
      func x(_ minute: Double) -> CGFloat {
        CGFloat(min(1, max(0, (minute + 30) / span))) * size.width
      }
      func y(_ mgdl: Double) -> CGFloat {
        let t = (mgdl - yMin) / (yMax - yMin)
        return 2 + (1 - t) * (size.height - 4)
      }
      var mark = Path()
      mark.move(to: CGPoint(x: x(0), y: 0))
      mark.addLine(to: CGPoint(x: x(0), y: size.height))
      context.stroke(mark, with: .color(Theme.accent.opacity(0.7)), style: StrokeStyle(lineWidth: 1, dash: [2, 3]))
      for group in groups(summary.points.map { ($0.minute, $0.mgdl) }) {
        if group.count == 1, let point = group.first {
          let rect = CGRect(x: x(point.0) - 2.2, y: y(Double(point.1)) - 2.2, width: 4.4, height: 4.4)
          context.fill(Path(ellipseIn: rect), with: .color(Theme.text))
        } else {
          var path = Path()
          for (index, point) in group.enumerated() {
            let spot = CGPoint(x: x(point.0), y: y(Double(point.1)))
            if index == 0 { path.move(to: spot) } else { path.addLine(to: spot) }
          }
          context.stroke(path, with: .color(Theme.text), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
        }
      }
    }
    .frame(height: 44)
    .accessibilityHidden(true)
  }

  private func stat(_ title: String, _ value: String, _ note: String?) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title).font(.system(size: 11)).foregroundStyle(Theme.muted)
      Text(value)
        .font(.system(size: 15, weight: .regular))
        .foregroundStyle(Theme.text)
        .monospacedDigit()
      if let note {
        Text(note).font(.system(size: 11)).foregroundStyle(Theme.muted)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var lowStat: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text("Low").font(.system(size: 11)).foregroundStyle(Theme.muted)
      if let value = summary.lowAfterMgdl {
        Text("\(value)")
          .font(.system(size: 15, weight: .medium))
          .monospacedDigit()
          .foregroundStyle(tone(value))
          .padding(.horizontal, 8)
          .padding(.vertical, 2)
          .background(tone(value).opacity(value < 120 || value > 180 ? 0.22 : 0.12), in: Capsule())
      } else {
        Text("—").font(.system(size: 15)).foregroundStyle(Theme.text)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func tone(_ value: Int) -> Color {
    if value < 120 { return Theme.warn }
    if value > 180 { return Theme.danger }
    return Theme.text
  }
}

struct DayGlucoseChart: View {
  var day: DayGlucose
  @State private var selected: String?

  var body: some View {
    Card {
      Text("Glucose")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Theme.text)
      if day.unavailable && day.points.isEmpty {
        Text("Glucose unavailable")
          .font(.system(size: 13))
          .foregroundStyle(Theme.muted)
      } else {
        ZStack {
          dayCanvas
          GeometryReader { geo in
            ForEach(day.markers) { marker in
              if let mgdl = marker.mgdl {
                Button {
                  selected = selected == marker.id ? nil : marker.id
                } label: {
                  RoundedRectangle(cornerRadius: marker.kind == "workout" ? 2 : 99, style: .continuous)
                    .fill(marker.kind == "workout" ? Theme.muted : Theme.accent)
                    .frame(width: marker.kind == "workout" ? 8 : 10, height: marker.kind == "workout" ? 8 : 10)
                    .overlay(
                      RoundedRectangle(cornerRadius: marker.kind == "workout" ? 2 : 99, style: .continuous)
                        .stroke(Theme.card, lineWidth: 2)
                    )
                    .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .position(x: xPos(marker.minute, width: geo.size.width), y: yPos(Double(mgdl), height: geo.size.height))
                .accessibilityLabel(caption(marker))
              }
            }
          }
        }
        .frame(height: 112)
        if let marker = day.markers.first(where: { $0.id == selected }) {
          VStack(alignment: .leading, spacing: 2) {
            Text(marker.name)
              .font(.system(size: 14, weight: .regular))
              .foregroundStyle(Theme.text)
            if marker.kind == "meal" {
              Text(macros(marker))
                .font(.system(size: 13))
                .foregroundStyle(Theme.muted)
            }
          }
        }
        if day.points.isEmpty {
          Text("No readings yet")
            .font(.system(size: 13))
            .foregroundStyle(Theme.muted)
        }
      }
    }
  }

  private var dayCanvas: some View {
    Canvas { context, size in
      let values = day.points.map { Double($0.mgdl) }
      let minV = values.min() ?? 70
      let maxV = values.max() ?? 180
      let pad = max(10, (maxV - minV) * 0.18)
      let yMin = minV - pad
      let yMax = max(maxV + pad, yMin + 1)
      func x(_ minute: Double) -> CGFloat { xPos(minute, width: size.width) }
      func y(_ mgdl: Double) -> CGFloat {
        let span = max(yMax - yMin, 1)
        let t = (mgdl - yMin) / span
        return 8 + (1 - t) * (size.height - 16)
      }
      for group in groups(day.points.map { ($0.minute, $0.mgdl) }) {
        if group.count == 1, let point = group.first {
          let rect = CGRect(x: x(point.0) - 2, y: y(Double(point.1)) - 2, width: 4, height: 4)
          context.fill(Path(ellipseIn: rect), with: .color(Theme.text))
        } else {
          var path = Path()
          for (index, point) in group.enumerated() {
            let spot = CGPoint(x: x(point.0), y: y(Double(point.1)))
            if index == 0 { path.move(to: spot) } else { path.addLine(to: spot) }
          }
          context.stroke(path, with: .color(Theme.text.opacity(0.85)), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
        }
      }
    }
    .accessibilityHidden(true)
  }

  private func xPos(_ minute: Double, width: CGFloat) -> CGFloat {
    let span = max(day.spanMinutes, 1)
    return CGFloat(min(1, max(0, minute / span))) * width
  }

  private func yPos(_ mgdl: Double, height: CGFloat) -> CGFloat {
    let values = day.points.map { Double($0.mgdl) }
    let minV = values.min() ?? 70
    let maxV = values.max() ?? 180
    let pad = max(10, (maxV - minV) * 0.18)
    let yMin = minV - pad
    let yMax = max(maxV + pad, yMin + 1)
    let t = (mgdl - yMin) / (yMax - yMin)
    return 8 + (1 - t) * (height - 16)
  }

  private func caption(_ marker: DayMarker) -> String {
    if marker.kind == "workout" { return marker.name }
    return "\(marker.name). \(macros(marker))"
  }

  private func macros(_ marker: DayMarker) -> String {
    let calories = Int((marker.calories ?? 0).rounded())
    let carbs = Format.qty(marker.carbs ?? 0)
    let protein = Format.qty(marker.protein ?? 0)
    let fat = Format.qty(marker.fat ?? 0)
    return "\(calories) kcal · \(carbs) g carbs · \(protein) g protein · \(fat) g fat"
  }
}

private func groups(_ points: [(Double, Int)]) -> [[(Double, Int)]] {
  let sorted = points.sorted { $0.0 < $1.0 }
  var grouped: [[(Double, Int)]] = []
  var current: [(Double, Int)] = []
  for point in sorted {
    if let previous = current.last, point.0 - previous.0 > 12 {
      grouped.append(current)
      current = []
    }
    current.append(point)
  }
  if !current.isEmpty { grouped.append(current) }
  return grouped
}
