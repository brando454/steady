import Foundation

enum CacheStore {
  private static var directory: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory
    let folder = base.appendingPathComponent("SteadyCache", isDirectory: true)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    return folder
  }

  static func save<T: Encodable>(_ value: T, name: String) {
    let url = directory.appendingPathComponent(name)
    guard let data = try? JSONEncoder().encode(value) else { return }
    try? data.write(to: url, options: .atomic)
  }

  static func load<T: Decodable>(_ type: T.Type, name: String) -> T? {
    let url = directory.appendingPathComponent(name)
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(type, from: data)
  }

  static func saveSession(_ session: WorkoutSession) {
    save(session, name: "session-\(session.id).json")
  }

  static func loadSession(_ id: String) -> WorkoutSession? {
    load(WorkoutSession.self, name: "session-\(id).json")
  }
}
