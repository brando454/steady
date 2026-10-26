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
    }
  }
}
