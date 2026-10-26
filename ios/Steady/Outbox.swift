import Foundation

struct LocalAction: Codable {
  var kind: String
  var exerciseId: String
  var setId: String?
  var setIndex: Int?
  var weightLb: Double?
  var reps: Double?
  var minutes: Double?
  var note: String?
  var isCardio: Bool
  var createdSetId: String?
  var createdExerciseId: String?
  var swapExerciseId: String?
  var scope: String?
  var customName: String?
}

struct LocalWorkout: Codable, Identifiable {
  var id: UUID
  var dayId: String
  var session: WorkoutSession
  var actions: [LocalAction]
  var applied: Int
  var serverSessionId: String?
  var idMap: [String: String]
}

enum OutboxItem: Codable, Identifiable {
  case http(id: UUID, method: String, path: String, body: Data?)
  case local(LocalWorkout)

  var id: UUID {
    switch self {
    case .http(let id, _, _, _): return id
    case .local(let workout): return workout.id
    }
  }
}

enum SyncEngine {
  static func replay(local: inout LocalWorkout, api: APIClient, save: (LocalWorkout) -> Void) async throws -> WorkoutSession {
    var session: WorkoutSession
    if let existing = local.serverSessionId {
      session = try await api.session(existing)
    } else {
      session = try await api.startSession(dayId: local.dayId)
      local.serverSessionId = session.id
      if local.idMap.isEmpty { mapInitially(&local, server: session) }
      save(local)
    }
    while local.applied < local.actions.count {
      let action = local.actions[local.applied]
      if action.kind == "discard" {
        if let id = local.serverSessionId { try await api.discard(id) }
        local.applied += 1
        save(local)
        return session
      }
      do {
        session = try await apply(action, session: session, local: &local, api: api)
      } catch is Skip {
        if let id = local.serverSessionId, let fresh = try? await api.session(id) {
          session = fresh
        }
      }
      local.applied += 1
      save(local)
    }
    return session
  }

  private static func mapInitially(_ local: inout LocalWorkout, server: WorkoutSession) {
    let locals = local.session.exercises.sorted { $0.sortOrder < $1.sortOrder }
    let servers = server.exercises.sorted { $0.sortOrder < $1.sortOrder }
    for pair in zip(locals, servers) {
      local.idMap[pair.0.id] = pair.1.id
      for sets in zip(pair.0.sets.sorted { $0.setIndex < $1.setIndex }, pair.1.sets.sorted { $0.setIndex < $1.setIndex }) {
        local.idMap[sets.0.id] = sets.1.id
      }
    }
  }

  private static func apply(_ action: LocalAction, session: WorkoutSession, local: inout LocalWorkout, api: APIClient) async throws -> WorkoutSession {
    switch action.kind {
    case "patch":
      guard let setId = action.setId, let serverSet = local.idMap[setId] else { return session }
      return try await ignoringConflict { try await api.patchSet(serverSet, body: body(action)) }
    case "log":
      guard let setId = action.setId, let serverSet = local.idMap[setId] else { return session }
      return try await ignoringConflict { try await api.logSet(serverSet, body: body(action)) }
    case "add":
      guard let serverExercise = local.idMap[action.exerciseId] else { return session }
      let before = Set(session.exercises.flatMap { $0.sets.map(\.id) })
      let next = try await api.addSet(serverExercise)
      if let created = action.createdSetId,
         let added = next.exercises.flatMap(\.sets).first(where: { !before.contains($0.id) }) {
        local.idMap[created] = added.id
      }
      return next
    case "delete":
      guard let setId = action.setId, let serverSet = local.idMap[setId] else { return session }
      return try await ignoringConflict { try await api.deleteSet(serverSet) }
    case "swap":
      guard let serverSession = local.serverSessionId else { return session }
      let serverExercise = local.idMap[action.exerciseId] ?? action.exerciseId
      var payload: [String: AnyEncodable] = [
        "sessionExerciseId": AnyEncodable(serverExercise),
        "scope": AnyEncodable(action.scope ?? "today"),
      ]
      if let exerciseId = action.swapExerciseId, !exerciseId.isEmpty {
        payload["exerciseId"] = AnyEncodable(exerciseId)
      }
      if let custom = action.customName, !custom.isEmpty {
        payload["customName"] = AnyEncodable(custom)
      }
      let before = Set(session.exercises.map(\.id))
      let next = try await api.swap(serverSession, body: payload)
      let localExerciseId = action.createdExerciseId ?? action.exerciseId
      let serverMatch = next.exercises.first { !before.contains($0.id) }
        ?? next.exercises.first { $0.exerciseId == action.swapExerciseId }
        ?? next.exercises.first { $0.id == serverExercise }
      if let serverMatch, let localExercise = local.session.exercises.first(where: { $0.id == localExerciseId }) {
        local.idMap[localExerciseId] = serverMatch.id
        for set in localExercise.sets {
          if let match = serverMatch.sets.first(where: { $0.setIndex == set.setIndex }) {
            local.idMap[set.id] = match.id
          }
        }
      }
      return next
    case "finish":
      guard let serverSession = local.serverSessionId else { return session }
      return try await api.finish(serverSession)
    default:
      return session
    }
  }

  private static func body(_ action: LocalAction) -> [String: AnyEncodable] {
    if action.isCardio {
      return ["minutes": AnyEncodable(action.minutes), "note": AnyEncodable(action.note ?? "")]
    }
    return ["weightLb": AnyEncodable(action.weightLb), "reps": AnyEncodable(action.reps)]
  }

  private static func ignoringConflict(_ work: () async throws -> WorkoutSession) async throws -> WorkoutSession {
    do {
      return try await work()
    } catch let error as APIError {
      if case .server(_, let status) = error, status == 404 || status == 409 { throw Skip() }
      throw error
    }
  }
}

private struct Skip: Error {}
