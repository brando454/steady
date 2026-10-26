import SwiftUI

struct SettingsView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var calories = ""
  @State private var protein = ""
  @State private var carbs = ""
  @State private var fat = ""
  @State private var weight = ""
  @State private var rampStart = ""
  @State private var week1 = ""
  @State private var week2 = ""
  @State private var nightscout = "Checking…"
  @State private var error: String?
  @State private var confirmClear = false

  var body: some View {
    NavigationStack {
      Form {
        Section("Nightscout") {
          Text(nightscout)
            .font(.system(size: 15))
            .foregroundStyle(Theme.muted)
          Text("Read only. Steady never writes to Nightscout or Loop.")
            .font(.system(size: 13))
            .foregroundStyle(Theme.muted)
        }
        if let note = model.settings?.rampNote, !note.isEmpty {
          Section {
            Text(note).foregroundStyle(Theme.warn)
          }
        }
        Section("Targets") {
          field("Name", text: $name)
          field("Calories", text: $calories, number: true)
          field("Protein (g)", text: $protein, number: true)
          field("Carbs (g)", text: $carbs, number: true)
          field("Fat (g)", text: $fat, number: true)
          field("Weight goal (lb)", text: $weight, number: true)
        }
        Section {
          Text("A note only. Working weights are not scaled for you.")
            .font(.system(size: 13))
            .foregroundStyle(Theme.muted)
          field("First ramp week", text: $rampStart)
          field("Week 1 %", text: $week1, number: true)
          field("Week 2 %", text: $week2, number: true)
        } header: {
          Text("Return ramp")
        }
        if let error {
          Section {
            Text(error).foregroundStyle(Theme.danger)
          }
        }
        Section {
          Button("Save") { save() }
            .disabled(model.busy)
          if model.settings?.samples == true {
            Button("Clear sample history", role: .destructive) { confirmClear = true }
            Text("Sample workouts, meals, and weigh-ins are here so the app isn't empty. They are not added on a production deploy.")
              .font(.system(size: 13))
              .foregroundStyle(Theme.muted)
          }
          Button("Forget this phone", role: .destructive) {
            model.logout()
            dismiss()
          }
        }
      }
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { dismiss() }
        }
      }
    }
    .task {
      await model.loadSettings()
      fill()
      nightscout = await model.glucoseStatusText()
    }
    .confirmationDialog("Clear sample history?", isPresented: $confirmClear, titleVisibility: .visible) {
      Button("Clear", role: .destructive) { model.clearSamples() }
      Button("Cancel", role: .cancel) {}
    }
  }

  private func field(_ title: String, text: Binding<String>, number: Bool = false) -> some View {
    LabeledContent(title) {
      TextField(title, text: text)
        .keyboardType(number ? .decimalPad : .default)
        .multilineTextAlignment(.trailing)
    }
  }

  private func fill() {
    guard let settings = model.settings else { return }
    name = settings.displayName
    calories = Format.qty(settings.calories)
    protein = Format.qty(settings.protein)
    carbs = Format.qty(settings.carbs)
    fat = Format.qty(settings.fat)
    weight = Format.qty(settings.weightLb)
    rampStart = settings.ramp.startDate
    week1 = String(settings.ramp.weeks.first { $0.offset == 0 }?.percent ?? 70)
    week2 = String(settings.ramp.weeks.first { $0.offset == 1 }?.percent ?? 85)
  }

  private func save() {
    guard
      let calories = Double(calories),
      let protein = Double(protein),
      let carbs = Double(carbs),
      let fat = Double(fat),
      let weight = Double(weight),
      let week1 = Int(week1),
      let week2 = Int(week2),
      !name.trimmingCharacters(in: .whitespaces).isEmpty,
      rampStart.count == 10
    else {
      error = "Check the numbers"
      return
    }
    error = nil
    model.saveSettings(
      displayName: name.trimmingCharacters(in: .whitespaces),
      calories: calories,
      protein: protein,
      carbs: carbs,
      fat: fat,
      weightLb: weight,
      rampStart: rampStart,
      week1: week1,
      week2: week2
    )
  }
}
