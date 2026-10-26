import SwiftUI

struct WeightView: View {
  @EnvironmentObject private var model: AppModel
  @State private var text = ""
  @State private var seeded = false

  var body: some View {
    ScreenStack {
      Text("Weight")
        .font(.system(size: 20, weight: .semibold))
        .foregroundStyle(Theme.text)
      BannerText(text: model.banner)
      if let data = model.weights {
        Card {
          HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
              Text("7-day average").font(.system(size: 13)).foregroundStyle(Theme.muted)
              if let average = data.average {
                Text("\(Format.qty(average)) lb")
                  .font(.system(size: 28, weight: .light))
                  .foregroundStyle(Theme.text)
              } else {
                Text("Log a few mornings to see your average")
                  .font(.system(size: 13)).foregroundStyle(Theme.muted)
              }
            }
            Spacer()
            if let change = changeText(data) {
              Text(change).font(.system(size: 13)).foregroundStyle(Theme.muted).multilineTextAlignment(.trailing)
            }
          }
          TrendChart(
            points: data.points.map { (date: $0.date, dot: $0.weightLb, line: $0.average) },
            target: data.target
          )
          .frame(height: 150)
          Text(data.hint.text).font(.system(size: 13)).foregroundStyle(Theme.muted)
        }
        Card {
          Text("This morning").font(.system(size: 13)).foregroundStyle(Theme.muted)
          TextField("lb", text: $text)
            .keyboardType(.decimalPad)
            .font(.system(size: 22, weight: .light))
            .padding(12)
            .background(Theme.fill)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
          PrimaryButton(title: "Save weigh-in", enabled: !model.busy && !text.isEmpty) {
            model.saveWeight(text)
          }
        }
      } else {
        Text("Loading weight…").foregroundStyle(Theme.muted)
      }
    }
    .onAppear {
      guard !seeded else { return }
      seeded = true
      if let today = model.weights?.today { text = Format.qty(today) }
    }
    .onChange(of: model.weights?.today) { _, value in
      if let value, text.isEmpty { text = Format.qty(value) }
    }
  }

  private func changeText(_ data: WeightChart) -> String? {
    guard let change = data.change else { return nil }
    if abs(change) < 0.05 { return "No change this week" }
    if change > 0 { return "Up \(Format.qty(change)) lb this week" }
    return "Down \(Format.qty(abs(change))) lb this week"
  }
}

struct TrendChart: View {
  var points: [(date: String, dot: Double?, line: Double?)]
  var target: Double?

  var body: some View {
    GeometryReader { geo in
      let values = points.flatMap { [$0.dot, $0.line, target].compactMap { $0 } }
      let low = (values.min() ?? 0) - 1
      let high = (values.max() ?? 1) + 1
      let span = max(0.5, high - low)
      ZStack {
        if let target {
          let y = yPos(target, low: low, span: span, height: geo.size.height)
          Path { path in
            path.move(to: CGPoint(x: 0, y: y))
            path.addLine(to: CGPoint(x: geo.size.width, y: y))
          }
          .stroke(Theme.line, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
        }
        Path { path in
          var started = false
          for (index, point) in points.enumerated() {
            guard let value = point.line else { continue }
            let x = xPos(index, count: points.count, width: geo.size.width)
            let y = yPos(value, low: low, span: span, height: geo.size.height)
            if started { path.addLine(to: CGPoint(x: x, y: y)) }
            else { path.move(to: CGPoint(x: x, y: y)); started = true }
          }
        }
        .stroke(Theme.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
        ForEach(Array(points.enumerated()), id: \.offset) { index, point in
          if let value = point.dot {
            Circle()
              .fill(Theme.text)
              .frame(width: 5, height: 5)
              .position(
                x: xPos(index, count: points.count, width: geo.size.width),
                y: yPos(value, low: low, span: span, height: geo.size.height)
              )
          }
        }
      }
    }
  }

  private func xPos(_ index: Int, count: Int, width: CGFloat) -> CGFloat {
    guard count > 1 else { return width / 2 }
    return CGFloat(index) / CGFloat(count - 1) * width
  }

  private func yPos(_ value: Double, low: Double, span: Double, height: CGFloat) -> CGFloat {
    let ratio = (value - low) / span
    return height - CGFloat(ratio) * height
  }
}
