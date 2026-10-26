import SwiftUI

struct RootView: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    Group {
      if model.booting {
        Text("Steady")
          .font(.system(size: 20, weight: .semibold))
          .foregroundStyle(Theme.text)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(Theme.bg)
      } else if model.unlocked {
        shell
      } else {
        LockView()
      }
    }
    .tint(Theme.accent)
  }

  private var shell: some View {
    VStack(spacing: 0) {
      statusLine
      ZStack {
        switch model.tab {
        case .today: TodayView()
        case .workout: WorkoutView()
        case .food: FoodView()
        case .weight: WeightView()
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      SlimTabs(tab: $model.tab)
    }
    .background(Theme.bg)
  }

  @ViewBuilder private var statusLine: some View {
    if !model.online || model.pending > 0 {
      Text(model.online ? "\(model.pending) change\(model.pending == 1 ? "" : "s") waiting to sync" : "Offline. Changes stay on this phone until you're back.")
        .font(.system(size: 12, weight: .regular))
        .foregroundStyle(Theme.muted)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(Theme.accentSoft)
    }
  }
}

struct LockView: View {
  @EnvironmentObject private var model: AppModel
  @State private var passcode = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("Steady")
        .font(.system(size: 20, weight: .semibold))
        .foregroundStyle(Theme.text)
      Text("Enter the passcode")
        .font(.system(size: 15, weight: .regular))
        .foregroundStyle(Theme.muted)
      SecureField("Passcode", text: $passcode)
        .textContentType(.password)
        .font(.system(size: 17, weight: .regular))
        .padding(14)
        .background(Theme.card)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      BannerText(text: model.banner)
      PrimaryButton(title: model.busy ? "Checking…" : "Continue", enabled: !model.busy && !passcode.isEmpty) {
        Task { await model.login(passcode) }
      }
    }
    .padding(24)
    .frame(maxWidth: 420)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.bg)
  }
}
