import PhotosUI
import SwiftUI
import UIKit

private struct EntrySnapshot {
  var draft: MealDraft
  var estimateImage: String?
  var photoNote: String?
  var loaded: Favorite?
  var editingId: String?
  var date: String
  var time: String
  var banner: String?
}

/// Tapping a saved meal fills the estimate. It does not log, and it does not change the saved meal.
struct FoodView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var draft = MealDraft.empty
  @State private var estimateImage: String?
  @State private var photoNote: String?
  @State private var loaded: Favorite?
  @State private var editingId: String?
  @State private var editingFavs = false
  @State private var date = ""
  @State private var time = ""
  @State private var seeded = false
  @State private var scrollToken = 0
  @State private var removeId: String?
  @State private var showCamera = false
  @State private var showLibrary = false
  @State private var libraryItem: PhotosPickerItem?
  @State private var estimating = false
  @State private var estimateGeneration = 0
  @State private var undoEntry: EntrySnapshot?
  @State private var undoTask: Task<Void, Never>?

  var body: some View {
    ScrollViewReader { proxy in
      ScreenStack {
        Text(editingId == nil ? "Log a meal" : "Edit meal")
          .font(.system(size: 20, weight: .semibold))
          .foregroundStyle(Theme.text)
        BannerText(text: model.banner)
        if let food = model.food {
          usuals(food)
          photoNoteRow
          estimateButton
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
    .fullScreenCover(isPresented: $showCamera) {
      CameraPicker(
        onImage: { image in
          showCamera = false
          applyPhoto(image)
        },
        onCancel: { showCamera = false }
      )
      .ignoresSafeArea()
    }
    .photosPicker(isPresented: $showLibrary, selection: $libraryItem, matching: .images)
    .onChange(of: libraryItem) { _, item in
      guard let item else { return }
      Task { @MainActor in
        let loaded = try? await item.loadTransferable(type: MealLibraryPhoto.self)
        let image = loaded?.image
        if let image {
          applyPhoto(image)
        } else {
          model.banner = "Could not read that photo"
        }
        libraryItem = nil
      }
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
    .overlay(alignment: .bottom) {
      if undoEntry != nil {
        undoToast
          .padding(.horizontal, 12)
          .padding(.bottom, 8)
      }
    }
  }

  private var entryIsBlank: Bool {
    func blank(_ value: String) -> Bool {
      value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    let photo = draft.photo?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let estimate = estimateImage?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return photo.isEmpty && estimate.isEmpty && blank(draft.note) && blank(draft.name)
      && blank(draft.calories) && blank(draft.protein) && blank(draft.carbs) && blank(draft.fat)
  }

  private var undoToast: some View {
    HStack(spacing: 12) {
      Text("Cleared")
        .font(.system(size: 15, weight: .regular))
      Spacer(minLength: 8)
      Button("Undo") { undoClear() }
        .font(.system(size: 15, weight: .semibold))
        .buttonStyle(.plain)
    }
    .foregroundStyle(Theme.bg)
    .padding(.leading, 16)
    .padding(.trailing, 10)
    .frame(minHeight: 44)
    .background(Theme.text, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .accessibilityElement(children: .contain)
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

  private var shownPhoto: String? { draft.photo ?? estimateImage }

  private var photoNoteRow: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 14) {
        Menu {
          if UIImagePickerController.isSourceTypeAvailable(.camera) {
            Button("Take photo") { showCamera = true }
          }
          Button("Choose photo") { showLibrary = true }
        } label: {
          ZStack {
            Theme.fill
            if let shownPhoto, let image = MealPhoto.image(from: shownPhoto) {
              Image(uiImage: image)
                .resizable()
                .scaledToFill()
            } else {
              Text("Photo")
                .font(.system(size: 12))
                .foregroundStyle(Theme.muted)
            }
          }
          .frame(width: 92, height: 92)
          .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .menuStyle(.borderlessButton)
        .buttonStyle(.plain)
        .disabled(estimating)
        .accessibilityLabel(shownPhoto == nil ? "Add a photo" : "Change photo")

        TextField("About 1.5 cups jasmine rice, 6 oz beef, light teriyaki", text: $draft.note, axis: .vertical)
          .lineLimit(3...6)
          .font(.system(size: 13))
          .padding(10)
          .frame(maxWidth: .infinity, minHeight: 92, alignment: .topLeading)
          .background(Theme.card)
          .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.line, lineWidth: 1))
          .disabled(estimating)
      }
      if shownPhoto != nil {
        QuietButton(title: "Remove photo") { removePhoto() }
          .disabled(estimating)
      }
      Text("Add a photo, a note, or both. The note fills in what the camera can't see, like portions or sauce.")
        .font(.system(size: 13))
        .foregroundStyle(Theme.muted)
        .fixedSize(horizontal: false, vertical: true)
      if let photoNote {
        Text(photoNote)
          .font(.system(size: 13))
          .foregroundStyle(Theme.muted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private var estimateEnabled: Bool {
    !estimating && !model.busy && model.food?.aiConfigured == true
  }

  private var estimateButton: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button {
        Task { await estimateMeal() }
      } label: {
        HStack(spacing: 8) {
          if estimating {
            ProgressView()
              .controlSize(.small)
              .tint(Theme.text)
          }
          Text(estimating ? "Estimating…" : "Estimate")
            .font(.system(size: 14, weight: .semibold))
        }
        .foregroundStyle(Theme.text)
        .frame(maxWidth: .infinity)
        .frame(minHeight: 44)
        .background(Theme.fill)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .opacity(estimateEnabled ? 1 : 0.45)
      }
      .buttonStyle(.plain)
      .disabled(!estimateEnabled)
      if model.food?.aiConfigured == false {
        Text("No AI key is set. Enter the meal yourself.")
          .font(.system(size: 13))
          .foregroundStyle(Theme.muted)
      }
    }
  }

  private var estimateCard: some View {
    Card {
      HStack(alignment: .firstTextBaseline) {
        Text(draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Meal" : draft.name)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(Theme.text)
        Spacer(minLength: 8)
        if entryIsBlank {
          Text("Estimate, edit anything")
            .font(.system(size: 13))
            .foregroundStyle(Theme.muted)
        } else {
          Button(action: clearEntry) {
            Text("Clear")
              .font(.system(size: 13, weight: .regular))
              .foregroundStyle(Theme.accent)
          }
          .buttonStyle(.plain)
        }
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
          if let photo = meal.photo, let image = MealPhoto.image(from: photo) {
            Image(uiImage: image)
              .resizable()
              .scaledToFill()
              .frame(width: 36, height: 36)
              .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
          }
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
    estimateImage = nil
    photoNote = nil
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
    estimateImage = nil
    photoNote = nil
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
    estimateImage = nil
    photoNote = nil
  }

  private func removePhoto() {
    draft.photo = nil
    estimateImage = nil
    photoNote = nil
  }

  private func applyPhoto(_ image: UIImage) {
    guard let prepared = MealPhoto.prepare(image) else {
      model.banner = "Could not read that photo"
      return
    }
    estimateImage = prepared.estimate
    draft.photo = prepared.preview
    photoNote = prepared.droppedPreview ? "That photo is too big to keep. You can still estimate from it." : nil
    model.banner = nil
  }

  private func estimateMeal() async {
    guard !estimating else { return }
    let note = draft.note.trimmingCharacters(in: .whitespacesAndNewlines)
    let image = estimateImage ?? draft.photo
    if note.isEmpty && (image == nil || image?.isEmpty == true) {
      model.banner = "Add a photo, a note, or both."
      return
    }
    if !model.online {
      model.banner = AppModel.offlineEstimate
      return
    }
    let generation = estimateGeneration
    estimating = true
    let result = await model.estimate(note: draft.note, imageDataUrl: image)
    guard generation == estimateGeneration else { return }
    estimating = false
    guard let result else { return }
    draft.name = result.name
    draft.calories = Format.qty(result.calories)
    draft.protein = Format.qty(result.protein)
    draft.carbs = Format.qty(result.carbs)
    draft.fat = Format.qty(result.fat)
    scrollToken += 1
  }

  private func clearEntry() {
    let snapshot = EntrySnapshot(
      draft: draft,
      estimateImage: estimateImage,
      photoNote: photoNote,
      loaded: loaded,
      editingId: editingId,
      date: date,
      time: time,
      banner: model.banner
    )
    estimateGeneration += 1
    estimating = false
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    draft = .empty
    estimateImage = nil
    photoNote = nil
    loaded = nil
    editingId = nil
    model.banner = nil
    date = Boise.civil()
    time = Boise.timeValue()
    showUndo(snapshot)
  }

  private func undoClear() {
    guard let snapshot = undoEntry else { return }
    undoTask?.cancel()
    undoTask = nil
    estimateGeneration += 1
    draft = snapshot.draft
    estimateImage = snapshot.estimateImage
    photoNote = snapshot.photoNote
    loaded = snapshot.loaded
    editingId = snapshot.editingId
    date = snapshot.date
    time = snapshot.time
    model.banner = snapshot.banner
    undoEntry = nil
  }

  private func showUndo(_ snapshot: EntrySnapshot) {
    undoEntry = snapshot
    undoTask?.cancel()
    undoTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 5_000_000_000)
      guard !Task.isCancelled else { return }
      undoEntry = nil
    }
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
