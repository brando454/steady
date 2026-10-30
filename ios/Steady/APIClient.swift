import Foundation

enum APIError: LocalizedError {
  case locked
  case server(String, Int)
  case offline
  case badResponse

  var errorDescription: String? {
    switch self {
    case .locked: return "Locked"
    case .server(let message, _): return message
    case .offline: return "You're offline. This will sync when you're back."
    case .badResponse: return "Something went wrong"
    }
  }

  static func isOffline(_ error: Error) -> Bool {
    if case APIError.offline = error { return true }
    guard let url = error as? URLError else { return false }
    switch url.code {
    case .notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .dataNotAllowed, .internationalRoamingOff:
      return true
    default:
      return false
    }
  }
}

final class APIClient {
  let root = "https://steady-re7n.onrender.com"
  var token: String?

  func login(passcode: String) async throws -> String {
    let response: LoginResponse = try await send("POST", "/api/auth/login", body: ["passcode": AnyEncodable(passcode)], auth: false)
    return response.token
  }

  func me() async throws {
    let _: OkResponse = try await send("GET", "/api/auth/me")
  }

  func today() async throws -> Today { try await send("GET", "/api/today") }
  func program() async throws -> Program { try await send("GET", "/api/program") }
  func week() async throws -> WeekPlan { try await send("GET", "/api/week") }
  func settings() async throws -> Settings { try await send("GET", "/api/settings") }
  func saveSettings(_ body: [String: AnyEncodable]) async throws -> Settings { try await send("PUT", "/api/settings", body: body) }
  func clearSamples() async throws { let _: OkResponse = try await send("POST", "/api/samples/clear") }
  func startSession(dayId: String) async throws -> WorkoutSession {
    try await send("POST", "/api/sessions", body: ["dayId": AnyEncodable(dayId)])
  }
  func session(_ id: String) async throws -> WorkoutSession { try await send("GET", "/api/sessions/\(enc(id))") }
  func finish(_ id: String) async throws -> WorkoutSession { try await send("POST", "/api/sessions/\(enc(id))/finish") }
  func discard(_ id: String) async throws { let _: OkResponse = try await send("DELETE", "/api/sessions/\(enc(id))") }
  func swap(_ id: String, body: [String: AnyEncodable]) async throws -> WorkoutSession {
    try await send("POST", "/api/sessions/\(enc(id))/swap", body: body)
  }
  func addSet(_ sessionExerciseId: String) async throws -> WorkoutSession {
    try await send("POST", "/api/session-exercises/\(enc(sessionExerciseId))/sets")
  }
  func patchSet(_ id: String, body: [String: AnyEncodable]) async throws -> WorkoutSession {
    try await send("PATCH", "/api/sets/\(enc(id))", body: body)
  }
  func logSet(_ id: String, body: [String: AnyEncodable]) async throws -> WorkoutSession {
    try await send("POST", "/api/sets/\(enc(id))/log", body: body)
  }
  func logRound(_ sessionId: String, sets: [RoundSetBody]) async throws -> WorkoutSession {
    try await send("POST", "/api/sessions/\(enc(sessionId))/rounds", body: ["sets": AnyEncodable(sets)])
  }
  func addRound(_ sessionId: String, sessionExerciseId: String) async throws -> WorkoutSession {
    try await send("POST", "/api/sessions/\(enc(sessionId))/rounds/add", body: ["sessionExerciseId": AnyEncodable(sessionExerciseId)])
  }
  func removeRound(_ sessionId: String, sessionExerciseId: String) async throws -> WorkoutSession {
    try await send("POST", "/api/sessions/\(enc(sessionId))/rounds/remove", body: ["sessionExerciseId": AnyEncodable(sessionExerciseId)])
  }
  func deleteSet(_ id: String) async throws -> WorkoutSession { try await send("DELETE", "/api/sets/\(enc(id))") }
  func skipSet(_ id: String) async throws -> WorkoutSession { try await send("POST", "/api/sets/\(enc(id))/skip") }
  func unskipSet(_ id: String) async throws -> WorkoutSession { try await send("POST", "/api/sets/\(enc(id))/unskip") }
  func skipExercise(_ id: String, sessionId: String, scope: String) async throws -> WorkoutSession {
    try await send("POST", "/api/session-exercises/\(enc(id))/skip", body: ["sessionId": AnyEncodable(sessionId), "scope": AnyEncodable(scope)])
  }
  func unskipExercise(_ id: String, sessionId: String, scope: String) async throws -> WorkoutSession {
    try await send("POST", "/api/session-exercises/\(enc(id))/unskip", body: ["sessionId": AnyEncodable(sessionId), "scope": AnyEncodable(scope)])
  }
  func history() async throws -> [HistoryItem] { try await send("GET", "/api/history") }
  func exerciseHistory(_ id: String) async throws -> ExerciseHistory { try await send("GET", "/api/exercises/\(enc(id))/history") }
  func meals(date: String?) async throws -> FoodDay {
    let query = date.flatMap { $0.isEmpty ? nil : "?date=\($0)" } ?? ""
    return try await send("GET", "/api/meals\(query)")
  }
  func createMeal(_ body: [String: AnyEncodable]) async throws -> Meal { try await send("POST", "/api/meals", body: body) }
  func updateMeal(_ id: String, body: [String: AnyEncodable]) async throws -> Meal {
    try await send("PUT", "/api/meals/\(enc(id))", body: body)
  }
  func deleteMeal(_ id: String) async throws { let _: OkResponse = try await send("DELETE", "/api/meals/\(enc(id))") }
  func estimate(note: String, imageDataUrl: String?) async throws -> MealEstimate {
    try await send(
      "POST",
      "/api/meals/estimate",
      body: ["note": AnyEncodable(note), "imageDataUrl": AnyEncodable(imageDataUrl)],
      timeout: 45
    )
  }
  func saveFavorite(_ body: [String: AnyEncodable]) async throws -> Favorite { try await send("POST", "/api/favorites", body: body) }
  func logFavorite(_ id: String, date: String, time: String) async throws -> Meal {
    try await send("POST", "/api/favorites/\(enc(id))/log", body: ["date": AnyEncodable(date), "time": AnyEncodable(time)])
  }
  func deleteFavorite(_ id: String) async throws { let _: OkResponse = try await send("DELETE", "/api/favorites/\(enc(id))") }
  func weights() async throws -> WeightChart { try await send("GET", "/api/weights") }
  func saveWeight(weightLb: Double, date: String?) async throws -> WeightChart {
    var body: [String: AnyEncodable] = ["weightLb": AnyEncodable(weightLb)]
    if let date { body["date"] = AnyEncodable(date) }
    return try await send("POST", "/api/weights", body: body)
  }
  func glucose() async throws -> Glucose { try await send("GET", "/api/glucose") }

  func sendRaw(method: String, path: String, body: Data?) async throws -> (Data, Int) {
    try await request(method: method, path: path, body: body, timeout: 30, auth: true)
  }

  private func send<T: Decodable>(_ method: String, _ path: String, body: [String: AnyEncodable]? = nil, timeout: TimeInterval = 30, auth: Bool = true) async throws -> T {
    let data = try body.map { try JSONEncoder().encode($0) }
    let (response, status) = try await request(method: method, path: path, body: data, timeout: timeout, auth: auth)
    if T.self == OkResponse.self, response.isEmpty {
      return OkResponse(ok: true) as! T
    }
    do {
      return try JSONDecoder().decode(T.self, from: response)
    } catch {
      if status >= 200 && status < 300, T.self == OkResponse.self {
        return OkResponse(ok: true) as! T
      }
      throw APIError.badResponse
    }
  }

  private func request(method: String, path: String, body: Data?, timeout: TimeInterval, auth: Bool) async throws -> (Data, Int) {
    guard let url = URL(string: root + path) else { throw APIError.badResponse }
    var request = URLRequest(url: url, timeoutInterval: timeout)
    request.httpMethod = method
    request.cachePolicy = .reloadIgnoringLocalCacheData
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    if auth, let token, !token.isEmpty {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await URLSession.shared.data(for: request)
    } catch {
      if APIError.isOffline(error) { throw APIError.offline }
      throw error
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 401, path != "/api/auth/login" { throw APIError.locked }
    if !(200..<300).contains(status) {
      let message = (try? JSONDecoder().decode(APIErrorBody.self, from: data))?.error ?? "Something went wrong"
      throw APIError.server(message, status)
    }
    return (data, status)
  }

  private func enc(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
  }
}
