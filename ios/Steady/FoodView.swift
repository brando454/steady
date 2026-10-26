import SwiftUI

/// Tapping a saved meal fills the estimate. It does not log, and it does not change the saved meal.
struct FoodView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var draft = MealDraft.empty
  @State private var loaded: Favorite?
  @State private var editingId: String?
  @State private var editingFavs = false
  @State private var date = ""
  @State private var time = ""
  @State private var seeded = false
  @State private var scrollToken = 0
  @State private var removeId: String?

  var body: some View {
    ScrollViewReader { proxy in
      ScreenStack {
        Text(editingId == nil ? "Log a meal" : "Edit meal")
          .font(.system(size: 20, weight: .semibold))
          .foregroundStyle(Theme.text)
        BannerText(text: model.banner)
        if let food = model.food {
          usuals(food)
          noteField
          estimateCard.id("estimate")
          loopCard
          actions
          whenFields
          logged(food)
        } else {
          Text("Loading food…").font(.system(size: 15)).foregroundStyle(Theme.muted)
        }
      }
      .onChange(of: scrollToken) { _, _ in
        guard scrollToken > 0 else { return }
        if reduceMotion {
          proxy.scrollTo("estimate", anchor: .top)
        } else {
          withAnimation(.easeInOut(duration: 0.35)) {
            proxy.scrollTo("estimate", anchor: .top)
          }
        }
      }
    }
    .onAppear {
      Task {
        await model.loadFood(date: date.isEmpty ? nil : date)
        if date.isEmpty { date = model.food?.date ?? "" }
        if time.isEmpty { time = String((model.food?.nowTime ?? "12:00").prefix(5)) }
        seeded = true
      }
    }
    .onChange(of: date) { _, value in
      guard seeded, value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return }
      Task { await model.loadFood(date: value) }
    }
    .confirmationDialog("Delete this meal?", isPresented: Binding(
      get: { removeId != nil },
      set: { if !$0 { removeId = nil } }
    ), titleVisibility: .visible) {
      Button("Delete", role: .destructive) {
        if let removeId { model.deleteMeal(removeId) }
        if editingId == removeId {
          editingId = nil
          clearForm()
        }
        removeId = nil
      }
      Button("Cancel", role: .cancel) { removeId = nil }
    } message: {
      Text("It comes off the day's totals.")
    }
  }

  private func usuals(_ food: FoodDay) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        VStack(alignment: .leading, spacing: 4) {
          Text("Your usuals").font(.system(size: 13)).foregroundStyle(Theme.muted)
          if !food.favorites.isEmpty {
            Text(editingFavs ? "Tap one to remove it" : "Swipe for more")
              .font(.system(size: 12))
              .foregroundStyle(Theme.muted)
          }
        }
        Spacer()
        if !food.favorites.isEmpty {
          QuietButton(title: editingFavs ? "Done" : "Edit") { editingFavs.toggle() }
        }
      }
      if food.favorites.isEmpty {
        Text("No usual meals yet.").font(.system(size: 13)).foregroundStyle(Theme.muted)
      } else {
        ScrollView(.horizontal, showsIndicators: false) {
          LazyHGrid(rows: [GridItem(.fixed(32), spacing: 6), GridItem(.fixed(32), spacing: 6)], spacing: 6) {
            ForEach(food.favorites) { favorite in
              Button {
                if editingFavs {
                  if loaded?.id == favorite.id { loaded = nil }
                  model.deleteFavorite(favorite.id)
                } else {
                  fill(favorite)
                }
              } label: {
                Text(favorite.name)
                  .font(.system(size: 12, weight: .semibold))
                  .lineLimit(1)
                  .padding(.horizontal, 12)
                  .frame(minHeight: 32)
                  .foregroundStyle(loaded?.id == favorite.id && !editingFavs ? Theme.accent : Theme.text)
                  .background(loaded?.id == favorite.id && !editingFavs ? Theme.accentSoft : Theme.fill, in: Capsule())
              }
              .buttonStyle(.plain)
              .accessibilityAddTraits(loaded?.id == favorite.id && !editingFavs ? .isSelected : [])
            }
          }
          .frame(height: 70)
        }
      }
    }
  }

  private var noteField: some View {
    TextField("About 1.5 cups jasmine rice, 6 oz beef, light teriyaki", text: $draft.note, axis: .vertical)
      .lineLimit(3...6)
      .font(.system(size: 13))
      .padding(10)
      .background(Theme.card)
      .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.line, lineWidth: 1))
  }

  private var estimateCard: some View {
    Card {
      HStack(alignment: .firstTextBaseline) {
        Text(draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Meal" : draft.name)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(Theme.text)
        Spacer()
        Text("Estimate, edit anything").font(.system(size: 13)).foregroundStyle(Theme.muted)
      }
      field("Name", text: $draft.name)
      LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
        field("Calories", text: $draft.calories, decimal: true)
        field("Protein (g)", text: $draft.protein, decimal: true)
        field("Carbs (g)", text: $draft.carbs, decimal: true)
        field("Fat (g)", text: $draft.fat, decimal: true)
      }
    }
  }

  private var loopCard: some View {
    HStack {
      VStack(alignment: .leading, spacing: 4) {
        Text("For Loop").font(.system(size: 13)).foregroundStyle(Theme.muted)
        Text(carbsLine)
          .font(.system(size: 24, weight: .semibold))
          .foregroundStyle(Theme.text)
      }
      Spacer()
      Text("You enter it in Loop").font(.system(size: 13)).foregroundStyle(Theme.muted)
    }
    .padding(18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.accentSoft)
    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
  }

  private var actions: some View {
    HStack(spacing: 8) {
      Button(usualTitle) { saveUsual() }
        .buttonStyle(.plain)
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(Theme.text)
        .frame(maxWidth: .infinity)
        .frame(minHeight: 44)
        .background(Theme.fill)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .disabled(model.busy)
      PrimaryButton(title: editingId == nil ? "Log meal" : "Save changes", enabled: !model.busy) { log() }
    }
  }

  private var whenFields: some View {
    HStack(spacing: 12) {
      field("Date", text: $date)
      field("Time", text: $time)
    }
  }

  private func logged(_ food: FoodDay) -> some View {
    Card {
      Text("Logged").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
      if food.meals.isEmpty {
        Text("Nothing logged for this day.").font(.system(size: 13)).foregroundStyle(Theme.muted)
      }
      ForEach(food.meals) { meal in
        HStack(alignment: .center, spacing: 8) {
          Button {
            fillLogged(meal)
          } label: {
            VStack(alignment: .leading, spacing: 2) {
              Text(meal.name).font(.system(size: 15)).foregroundStyle(Theme.text)
              Text("\(meal.timeLabel) · \(Format.grouped(meal.calories)) kcal, \(Format.qty(meal.protein)) g protein")
                .font(.system(size: 12))
                .foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          .buttonStyle(.plain)
          QuietButton(title: "Delete") { removeId = meal.id }
        }
      }
      if editingId != nil {
        QuietButton(title: "Delete meal") { removeId = editingId }
      }
    }
  }

  private func field(_ title: String, text: Binding<String>, decimal: Bool = false) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(.system(size: 12)).foregroundStyle(Theme.muted)
      TextField("", text: text)
        .keyboardType(decimal ? .decimalPad : .default)
        .textInputAutocapitalization(decimal ? .never : .sentences)
        .font(.system(size: 16, weight: .semibold))
        .padding(10)
        .background(Theme.bg)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.line, lineWidth: 1))
    }
  }

  private var carbsLine: String {
    guard let carbs = number(draft.carbs) else { return "— g carbs" }
    return "\(Format.qty(carbs)) g carbs"
  }

  private var usualTitle: String {
    guard let loaded else { return "Save as usual" }
    let sameName = draft.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      == loaded.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard sameName else { return "Save as usual" }
    let same = number(draft.calories) == loaded.calories
      && number(draft.protein) == loaded.protein
      && number(draft.carbs) == loaded.carbs
      && number(draft.fat) == loaded.fat
      && draft.note == (loaded.note ?? "")
    return same ? "Save as usual" : "Update usual"
  }

  private func fill(_ favorite: Favorite) {
    editingId = nil
    loaded = favorite
    draft.name = favorite.name
    draft.calories = Format.qty(favorite.calories)
    draft.protein = Format.qty(favorite.protein)
    draft.carbs = Format.qty(favorite.carbs)
    draft.fat = Format.qty(favorite.fat)
    draft.note = favorite.note ?? ""
    draft.photo = nil
    model.banner = nil
    scrollToken += 1
  }

  private func fillLogged(_ meal: Meal) {
    loaded = nil
    editingId = meal.id
    draft.name = meal.name
    draft.calories = Format.qty(meal.calories)
    draft.protein = Format.qty(meal.protein)
    draft.carbs = Format.qty(meal.carbs)
    draft.fat = Format.qty(meal.fat)
    draft.note = meal.note ?? ""
    draft.photo = meal.photo
    if !meal.date.isEmpty { date = meal.date }
    if let clock = boiseClock(meal.loggedAt) { time = clock }
    model.banner = nil
    scrollToken += 1
  }

  private func saveUsual() {
    guard let body = validated() else { return }
    model.banner = nil
    model.saveFavorite(
      name: body.name,
      calories: body.calories,
      protein: body.protein,
      carbs: body.carbs,
      fat: body.fat,
      note: draft.note
    )
    if let loaded, loaded.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == body.name.lowercased() {
      self.loaded = Favorite(
        id: loaded.id,
        name: body.name,
        calories: body.calories,
        protein: body.protein,
        carbs: body.carbs,
        fat: body.fat,
        note: draft.note.isEmpty ? nil : draft.note
      )
    } else {
      loaded = nil
    }
  }

  private func log() {
    guard let body = validated() else { return }
    draft.name = body.name
    draft.calories = Format.qty(body.calories)
    draft.protein = Format.qty(body.protein)
    draft.carbs = Format.qty(body.carbs)
    draft.fat = Format.qty(body.fat)
    draft.date = date.isEmpty ? (model.food?.today ?? model.food?.date ?? "") : date
    draft.time = time.isEmpty ? String((model.food?.nowTime ?? "12:00").prefix(5)) : String(time.prefix(5))
    model.banner = nil
    model.saveMeal(draft, editing: editingId)
    editingId = nil
    loaded = nil
    clearForm()
  }

  private func clearForm() {
    let keptDate = date
    let keptTime = time
    draft = .empty
    draft.date = keptDate
    draft.time = keptTime
  }

  private func validated() -> (name: String, calories: Double, protein: Double, carbs: Double, fat: Double)? {
    let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else {
      model.banner = "Enter a meal name"
      return nil
    }
    guard let calories = number(draft.calories),
          let protein = number(draft.protein),
          let carbs = number(draft.carbs),
          let fat = number(draft.fat) else {
      model.banner = "Enter calories, protein, carbs, and fat"
      return nil
    }
    return (name, calories, protein, carbs, fat)
  }

  private func number(_ text: String) -> Double? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return nil }
    return Double(trimmed)
  }

  private func boiseClock(_ iso: String) -> String? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let parsed = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    guard let parsed else { return nil }
    let out = DateFormatter()
    out.locale = Locale(identifier: "en_US_POSIX")
    out.timeZone = TimeZone(identifier: "America/Boise")
    out.dateFormat = "HH:mm"
    return out.string(from: parsed)
  }
}
