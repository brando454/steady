import SwiftUI
import UIKit

struct McpAccessView: View {
  @EnvironmentObject private var model: AppModel
  @State private var connections = SteadyConnections(tokens: [], connections: [])
  @State private var name = ""
  @State private var freshToken: String?
  @State private var error: String?
  @State private var loading = true
  @State private var busy = false
  @State private var pending: SteadyCredential?
  @State private var copied = ""

  private var connectorURL: String { model.api.root + "/api/steady/mcp" }

  var body: some View {
    ScreenStack {
      Text("Connect an AI tool to this Steady account. It can view and log workouts and body weight. It cannot write to Nightscout or Loop.")
        .font(.system(size: 16))
        .foregroundStyle(Theme.muted)
        .fixedSize(horizontal: false, vertical: true)

      Card {
        Text("Connector URL")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Theme.muted)
        Text(connectorURL)
          .font(.system(size: 15))
          .foregroundStyle(Theme.text)
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
        copyButton("Copy URL", value: connectorURL, mark: "url")
      }

      Card {
        Text("New personal token")
          .font(.system(size: 17, weight: .semibold))
        TextField("Name, such as Claude", text: $name)
          .textInputAutocapitalization(.words)
          .padding(.vertical, 8)
        PrimaryButton(title: busy ? "Creating…" : "Create token", enabled: !busy && !name.trimmingCharacters(in: .whitespaces).isEmpty) {
          Task { await create() }
        }
        if let freshToken {
          Text("You won't see this again.")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(Theme.warn)
            .padding(.top, 8)
          Text(freshToken)
            .font(.system(size: 15, design: .monospaced))
            .foregroundStyle(Theme.text)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
          copyButton("Copy token", value: freshToken, mark: "token")
        }
      }

      if let error {
        Text(error)
          .font(.system(size: 15))
          .foregroundStyle(Theme.danger)
      }

      credentialList("Personal tokens", rows: connections.tokens, empty: "No personal tokens yet.")
      credentialList("OAuth connections", rows: connections.connections, empty: "No signed-in apps yet.")

      if !copied.isEmpty {
        Text(copied == "token" ? "Token copied" : "URL copied")
          .font(.system(size: 14))
          .foregroundStyle(Theme.muted)
      }
    }
    .navigationTitle("MCP")
    .navigationBarTitleDisplayMode(.inline)
    .task { await load() }
    .confirmationDialog(
      "Revoke \(pending?.name ?? "this access")?",
      isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
      titleVisibility: .visible
    ) {
      Button("Revoke", role: .destructive) {
        let row = pending
        pending = nil
        if let row { Task { await revokeAccess(row) } }
      }
      Button("Cancel", role: .cancel) { pending = nil }
    } message: {
      Text("That connector stops working. This does not delete workouts.")
    }
  }

  private func credentialList(_ title: String, rows: [SteadyCredential], empty: String) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(title)
        .font(.system(size: 20, weight: .semibold))
        .foregroundStyle(Theme.text)
      if loading && rows.isEmpty {
        Text("Loading…")
          .font(.system(size: 15))
          .foregroundStyle(Theme.muted)
      } else if rows.isEmpty {
        Text(empty)
          .font(.system(size: 15))
          .foregroundStyle(Theme.muted)
      } else {
        ForEach(rows) { row in
          Card {
            Text(row.name)
              .font(.system(size: 17, weight: .semibold))
              .foregroundStyle(Theme.text)
            Text("Created \(shown(row.createdAt))")
              .font(.system(size: 14))
              .foregroundStyle(Theme.muted)
            Text(row.lastUsedAt == nil ? "Not used yet" : "Last used \(shown(row.lastUsedAt))")
              .font(.system(size: 14))
              .foregroundStyle(Theme.muted)
            Button("Revoke", role: .destructive) { pending = row }
              .font(.system(size: 15, weight: .semibold))
              .padding(.top, 4)
          }
        }
      }
    }
    .padding(.top, 8)
  }

  private func copyButton(_ title: String, value: String, mark: String) -> some View {
    Button(title) {
      UIPasteboard.general.string = value
      copied = mark
    }
    .font(.system(size: 15, weight: .semibold))
    .padding(.top, 4)
  }

  private func shown(_ iso: String?) -> String {
    guard let iso, !iso.isEmpty else { return "—" }
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    guard let date = withFraction.date(from: iso) ?? plain.date(from: iso) else { return iso }
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.timeZone = Boise.zone
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "MMM d, yyyy, h:mm a"
    return formatter.string(from: date)
  }

  private func load() async {
    do {
      connections = try await model.api.steadyConnections()
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
    loading = false
  }

  private func create() async {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let created = try await model.api.createSteadyToken(name: trimmed)
      freshToken = created.token
      name = ""
      error = nil
      if !connections.tokens.contains(where: { $0.id == created.id }) {
        connections.tokens.insert(SteadyCredential(id: created.id, name: created.name, createdAt: created.createdAt, lastUsedAt: nil), at: 0)
      }
    } catch {
      self.error = error.localizedDescription
    }
  }

  private func revokeAccess(_ row: SteadyCredential) async {
    do {
      try await model.api.revokeSteadyToken(row.id)
      connections.tokens.removeAll { $0.id == row.id }
      connections.connections.removeAll { $0.id == row.id }
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }
}
