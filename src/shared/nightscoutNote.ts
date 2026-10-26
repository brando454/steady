/** Fields a Steady Nightscout treatment is allowed to carry. Macros stay inside `notes`. */
export const NIGHTSCOUT_NOTE_KEYS = ["eventType", "created_at", "enteredBy", "notes", "_id", "id"] as const;

const ALLOWED = new Set<string>(NIGHTSCOUT_NOTE_KEYS);

export type MealNoteInput = {
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

/** `Chicken bowl · 22C 10P 15F · 450 cal` */
export function mealNoteText(meal: MealNoteInput): string {
  const round = (value: number) => String(Math.round(Number.isFinite(value) ? value : 0));
  const name = meal.name.trim().replace(/\s+/g, " ");
  return `${name} \u00b7 ${round(meal.carbs)}C ${round(meal.protein)}P ${round(meal.fat)}F \u00b7 ${round(meal.calories)} cal`;
}

export function nightscoutNotePayload(input: MealNoteInput & { createdAt: string; id?: string }): Record<string, string> {
  const payload: Record<string, string> = {
    eventType: "Note",
    created_at: input.createdAt,
    enteredBy: "Steady",
    notes: mealNoteText(input),
  };
  if (input.id) payload._id = input.id;
  assertNightscoutNoteSafe(payload);
  return payload;
}

/** Reject anything that could be read as a dose. Every allowed value is text. */
export function assertNightscoutNoteSafe(payload: Record<string, unknown>): void {
  const keys = Object.keys(payload);
  if (keys.length === 0) throw new Error("Nightscout note is empty");
  for (const key of keys) {
    if (!ALLOWED.has(key)) throw new Error(`Nightscout note refused field ${key}`);
    if (typeof payload[key] !== "string") throw new Error(`Nightscout note refused non-text field ${key}`);
  }
  if (payload.eventType !== "Note") throw new Error("Nightscout note refused eventType");
  if (payload.enteredBy !== "Steady") throw new Error("Nightscout note refused enteredBy");
  if (typeof payload.notes !== "string" || payload.notes.trim() === "") throw new Error("Nightscout note refused notes");
  if (payload.created_at == null || String(payload.created_at).trim() === "") throw new Error("Nightscout note refused created_at");
}
