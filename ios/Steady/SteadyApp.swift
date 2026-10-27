import SwiftUI

@main
struct SteadyApp: App {
  @StateObject private var model: AppModel

  init() {
    let model = AppModel()
    _model = StateObject(wrappedValue: model)
    AppRuntime.shared.model = model
    model.prepare()
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(model)
        .onOpenURL { model.open(url: $0) }
        .onChange(of: scenePhase) { _, phase in
          if phase == .active {
            Task { await model.becameActive() }
          }
        }
    }
  }

  @Environment(\.scenePhase) private var scenePhase
}
