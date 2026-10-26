import SwiftUI
import UIKit

struct Card<Content: View>: View {
  var content: Content
  init(@ViewBuilder content: () -> Content) { self.content = content() }
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      content
    }
    .padding(18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.card)
    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
  }
}

struct PrimaryButton: View {
  var title: String
  var enabled = true
  var action: () -> Void

  var body: some View {
    Button {
      UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
      action()
    } label: {
      Text(title)
        .font(.system(size: 14, weight: .semibold))
        .frame(maxWidth: .infinity)
        .frame(minHeight: 44)
    }
    .buttonStyle(.plain)
    .foregroundStyle(Theme.onAccent)
    .background(Theme.accent.opacity(enabled ? 1 : 0.45))
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    .disabled(!enabled)
  }
}

struct QuietButton: View {
  var title: String
  var action: () -> Void
  var body: some View {
    Button(title, action: action)
      .font(.system(size: 13, weight: .semibold))
      .foregroundStyle(Theme.accent)
      .frame(minHeight: 36)
  }
}

struct BannerText: View {
  var text: String?
  var body: some View {
    if let text, !text.isEmpty {
      Text(text)
        .font(.system(size: 13, weight: .regular))
        .foregroundStyle(Theme.danger)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

struct CalorieRing: View {
  var eaten: Double
  var target: Double
  var left: Double
  var size: CGFloat = 112

  private var fraction: Double {
    guard target > 0 else { return 0 }
    return min(1, max(0, eaten / target))
  }

  var body: some View {
    ZStack {
      Circle().stroke(Theme.fill, lineWidth: size >= 100 ? 8 : 7)
      Circle()
        .trim(from: 0, to: fraction)
        .stroke(Theme.accent, style: StrokeStyle(lineWidth: size >= 100 ? 8 : 7, lineCap: .round))
        .rotationEffect(.degrees(-90))
      VStack(spacing: 0) {
        Text(Format.grouped(left))
          .font(.system(size: figureSize, weight: .light))
          .foregroundStyle(Theme.text)
          .minimumScaleFactor(0.6)
          .lineLimit(1)
        Text(left < 0 ? "kcal over" : "kcal left")
          .font(.system(size: 11, weight: .light))
          .foregroundStyle(Theme.muted)
      }
      .padding(.horizontal, 8)
    }
    .frame(width: size, height: size)
  }

  private var figureSize: CGFloat {
    let text = Format.grouped(left)
    if text.count >= 6 { return 20 }
    if text.count >= 5 { return 23 }
    return 28
  }
}

struct MacroBars: View {
  var protein: (Double, Double)
  var carbs: (Double, Double)
  var fat: (Double, Double)
  var tight: CGFloat = 6
  var between: CGFloat = 11

  var body: some View {
    VStack(alignment: .leading, spacing: between) {
      bar("Protein", protein.0, protein.1)
      bar("Carbs", carbs.0, carbs.1)
      bar("Fat", fat.0, fat.1)
    }
  }

  private func bar(_ name: String, _ eaten: Double, _ target: Double) -> some View {
    VStack(alignment: .leading, spacing: tight) {
      HStack {
        Text(name).font(.system(size: 13, weight: .light)).foregroundStyle(Theme.text)
        Spacer(minLength: 8)
        Text(Format.qty(eaten))
          .font(.system(size: 13, weight: .light))
          .foregroundStyle(Theme.text)
        Text("/ \(Format.qty(target)) g")
          .font(.system(size: 13, weight: .light))
          .foregroundStyle(Theme.muted)
      }
      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule().fill(Theme.fill)
          Capsule()
            .fill(Theme.accent)
            .frame(width: max(6, geo.size.width * fraction(eaten, target)))
        }
      }
      .frame(height: 6)
    }
  }

  private func fraction(_ eaten: Double, _ target: Double) -> Double {
    guard target > 0 else { return 0 }
    return min(1, max(0, eaten / target))
  }
}

struct ScreenStack<Content: View>: View {
  var content: Content
  init(@ViewBuilder content: () -> Content) { self.content = content() }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        content
      }
      .padding(.horizontal, 16)
      .padding(.top, 12)
      .padding(.bottom, 24)
      .frame(maxWidth: 480)
      .frame(maxWidth: .infinity)
      .background(ScrollKeeper())
    }
    .background(Theme.bg)
    .scrollDismissesKeyboard(.interactively)
  }
}

/// Puts the scroller back if iOS throws it to the top when the keyboard closes.
private struct ScrollKeeper: UIViewRepresentable {
  func makeUIView(context: Context) -> UIView {
    let view = UIView(frame: .zero)
    view.isUserInteractionEnabled = false
    view.backgroundColor = .clear
    context.coordinator.watch(view)
    return view
  }

  func updateUIView(_ uiView: UIView, context: Context) {
    context.coordinator.watch(uiView)
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  final class Coordinator {
    weak var view: UIView?
    private var token: NSObjectProtocol?
    deinit {
      if let token { NotificationCenter.default.removeObserver(token) }
    }
    func watch(_ view: UIView) {
      self.view = view
      guard token == nil else { return }
      token = NotificationCenter.default.addObserver(
        forName: UIResponder.keyboardWillHideNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.pin()
      }
    }
    func pin() {
      guard let scroll = scroller(), scroll.contentOffset.y > 1 else { return }
      let y = scroll.contentOffset.y
      for delay in [0.0, 0.08, 0.2, 0.45] {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak scroll] in
          guard let scroll, scroll.contentOffset.y + 48 < y else { return }
          scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: y), animated: false)
        }
      }
    }
    func scroller() -> UIScrollView? {
      var current = view?.superview
      while let next = current {
        if let scroll = next as? UIScrollView { return scroll }
        current = next.superview
      }
      return nil
    }
  }
}

struct SlimTabs: View {
  @Binding var tab: AppTab
  var body: some View {
    HStack(spacing: 0) {
      ForEach(AppTab.allCases) { item in
        Button {
          tab = item
        } label: {
          VStack(spacing: 2) {
            RoundedRectangle(cornerRadius: 2)
              .fill(tab == item ? Theme.accent : Theme.fill)
              .frame(width: 18, height: 3)
            Text(item.title)
              .font(.system(size: 11, weight: tab == item ? .semibold : .regular))
              .foregroundStyle(tab == item ? Theme.text : Theme.muted)
          }
          .frame(maxWidth: .infinity)
          .frame(minHeight: 36)
        }
        .buttonStyle(.plain)
      }
    }
    .padding(.bottom, 0)
    .background(Theme.card)
    .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
  }
}
