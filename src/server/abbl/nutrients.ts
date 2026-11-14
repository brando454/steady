import { HttpError } from "../util";

/** Fiber is null when the source did not list it. Never coerce that to 0. */
export type Nutrients = {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number | null;
};

export type NutrientTotal = Nutrients & { fiber_unknown: boolean };

export type Ingredient = {
  name: string;
  grams: number;
  nutrients: Nutrients;
  source: string | null;
};

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function scaleNutrients(nutrients: Nutrients, factor: number): Nutrients {
  return {
    kcal: round1(nutrients.kcal * factor),
    protein_g: round1(nutrients.protein_g * factor),
    carbs_g: round1(nutrients.carbs_g * factor),
    fat_g: round1(nutrients.fat_g * factor),
    fiber_g: nutrients.fiber_g == null ? null : round1(nutrients.fiber_g * factor),
  };
}

/** Sum absolute nutrient amounts. Null fiber is unknown, not zero. */
export function totalNutrients(items: Nutrients[]): NutrientTotal {
  let kcal = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  let fiber = 0;
  let knownFiber = false;
  let fiberUnknown = false;
  for (const item of items) {
    kcal += item.kcal;
    protein += item.protein_g;
    carbs += item.carbs_g;
    fat += item.fat_g;
    if (item.fiber_g == null) fiberUnknown = true;
    else {
      knownFiber = true;
      fiber += item.fiber_g;
    }
  }
  return {
    kcal: round1(kcal),
    protein_g: round1(protein),
    carbs_g: round1(carbs),
    fat_g: round1(fat),
    fiber_g: knownFiber ? round1(fiber) : fiberUnknown ? null : 0,
    fiber_unknown: fiberUnknown,
  };
}

export function perServing(total: NutrientTotal, servings: number): NutrientTotal {
  return {
    ...scaleNutrients(total, 1 / servings),
    fiber_unknown: total.fiber_unknown,
  };
}

function readMacro(value: unknown, field: string): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number) || number < 0 || number > 20_000) throw new HttpError(400, `${field} looks off`);
  return round1(number);
}

export function readNutrients(value: unknown): Nutrients {
  if (!value || typeof value !== "object") throw new HttpError(400, "Nutrients are missing");
  const record = value as Record<string, unknown>;
  const fiber = record.fiber_g;
  return {
    kcal: readMacro(record.kcal, "kcal"),
    protein_g: readMacro(record.protein_g, "protein_g"),
    carbs_g: readMacro(record.carbs_g, "carbs_g"),
    fat_g: readMacro(record.fat_g, "fat_g"),
    fiber_g: fiber == null ? null : readMacro(fiber, "fiber_g"),
  };
}

export function readIngredient(value: unknown): Ingredient {
  if (!value || typeof value !== "object") throw new HttpError(400, "Ingredient is missing");
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name || name.length > 120) throw new HttpError(400, "Ingredient name looks off");
  const grams = readMacro(record.grams, "grams");
  if (grams <= 0) throw new HttpError(400, "grams looks off");
  const source = record.source == null || record.source === "" ? null : typeof record.source === "string" ? record.source.trim().slice(0, 40) : null;
  if (record.source != null && record.source !== "" && source == null) throw new HttpError(400, "source looks off");
  return { name, grams, nutrients: readNutrients(record.nutrients), source };
}

export function scaleIngredient(ingredient: Ingredient, factor: number): Ingredient {
  return {
    name: ingredient.name,
    grams: round1(ingredient.grams * factor),
    nutrients: scaleNutrients(ingredient.nutrients, factor),
    source: ingredient.source,
  };
}
