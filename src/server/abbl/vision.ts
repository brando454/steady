import { searchUsda } from "./foods";
import { HttpError } from "../util";
import { labelHasNutrient, readLabelNutrients, readNutrients, round1, type LabelNutrients, type Nutrients } from "./nutrients";

type FetchLike = typeof fetch;

export type EstimateIngredient = {
  photoIndex: number;
  name: string;
  grams: number;
  nutrients: Nutrients | null;
  confidence: number;
  uncertainty?: number;
  nutrition_missing?: true;
};

type DraftFood = {
  name: string;
  grams: number;
  nutrients: Nutrients | null;
  per100g: Nutrients | null;
};

export type NutritionLookup = (name: string) => Promise<Nutrients | null>;

export function macrosAreBlank(nutrients: Nutrients | null): boolean {
  return nutrients == null || (nutrients.kcal === 0 && nutrients.protein_g === 0 && nutrients.carbs_g === 0 && nutrients.fat_g === 0);
}

export function scalePer100g(per100g: Nutrients, grams: number): Nutrients {
  const factor = grams / 100;
  return {
    kcal: round1(per100g.kcal * factor),
    protein_g: round1(per100g.protein_g * factor),
    carbs_g: round1(per100g.carbs_g * factor),
    fat_g: round1(per100g.fat_g * factor),
    fiber_g: per100g.fiber_g == null ? null : round1(per100g.fiber_g * factor),
  };
}

function aiSettings(): { key: string; base: string; model: string } {
  const key = process.env.AI_API_KEY?.trim();
  if (!key) throw new HttpError(503, "Meal estimates are not configured");
  const base = (process.env.AI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.AI_MODEL?.trim() || "gpt-4o-mini";
  return { key, base, model };
}

export function jpegDataUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "Photo is missing");
  const trimmed = value.trim();
  const dataUrl = trimmed.startsWith("data:") ? trimmed : `data:image/jpeg;base64,${trimmed.replace(/\s/g, "")}`;
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) throw new HttpError(400, "Photo must be a base64 JPEG");
  return dataUrl;
}

async function complete(messages: unknown, fetchImpl: FetchLike): Promise<string> {
  const { key, base, model } = aiSettings();
  const body = { model, temperature: 0.2, messages, response_format: { type: "json_object" } };
  let response = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok && response.status === 400) {
    const { response_format: _ignored, ...withoutFormat } = body;
    response = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(withoutFormat),
      signal: AbortSignal.timeout(45_000),
    });
  }
  if (!response.ok) throw new HttpError(502, "The estimate didn't come back");
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const raw = payload.choices?.[0]?.message?.content;
  const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: string }).text ?? "") : "")).join("\n") : "";
  if (!text.trim()) throw new HttpError(502, "The estimate didn't come back");
  return text;
}

function jsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new HttpError(502, "The estimate didn't come back");
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(502, "The estimate didn't come back");
  }
}

function fraction(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  const unit = number > 1 ? number / 100 : number;
  return round1(Math.min(1, unit));
}

function optionalFraction(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  return fraction(value, 0);
}

function optionalNutrients(value: unknown): Nutrients | null {
  if (value == null) return null;
  try {
    const nutrients = readNutrients(value);
    return macrosAreBlank(nutrients) ? null : nutrients;
  } catch {
    return null;
  }
}

export async function usdaPer100g(name: string, fetchImpl: FetchLike = fetch): Promise<Nutrients | null> {
  const query = name.trim().slice(0, 80);
  if (query.length < 2) return null;
  try {
    const hits = await searchUsda(query, fetchImpl);
    const per100g = hits[0]?.per100g ?? null;
    return macrosAreBlank(per100g) ? null : per100g;
  } catch {
    return null;
  }
}

export async function fillNutrition(food: DraftFood, lookup: NutritionLookup): Promise<{ nutrients: Nutrients | null; nutrition_missing?: true }> {
  if (!macrosAreBlank(food.nutrients)) return { nutrients: food.nutrients };
  if (!macrosAreBlank(food.per100g)) return { nutrients: scalePer100g(food.per100g as Nutrients, food.grams) };
  try {
    const found = await lookup(food.name);
    if (!macrosAreBlank(found)) return { nutrients: scalePer100g(found as Nutrients, food.grams) };
  } catch {
    /* The lookup is optional. A miss is not a failed estimate. */
  }
  return { nutrients: null, nutrition_missing: true };
}

export function parseEstimate(text: string, photoCount: number): Array<DraftFood & { photoIndex: number; confidence: number; uncertainty?: number }> {
  const record = jsonObject(text);
  const list = Array.isArray(record.ingredients) ? record.ingredients : [];
  const items: Array<DraftFood & { photoIndex: number; confidence: number; uncertainty?: number }> = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const photoIndex = Number(row.photoIndex);
    if (!Number.isInteger(photoIndex) || photoIndex < 0 || photoIndex >= photoCount) continue;
    const name = typeof row.name === "string" ? row.name.trim().slice(0, 120) : "";
    const grams = Number(row.grams);
    if (!name || !Number.isFinite(grams) || grams <= 0) continue;
    const uncertainty = optionalFraction(row.uncertainty);
    items.push({
      photoIndex,
      name,
      grams: round1(grams),
      nutrients: optionalNutrients(row.nutrients),
      per100g: optionalNutrients(row.per100g),
      confidence: fraction(row.confidence, 0),
      ...(uncertainty == null ? {} : { uncertainty }),
    });
  }
  return items.sort((a, b) => a.photoIndex - b.photoIndex);
}

const ESTIMATE_PROMPT = [
  "You estimate foods for a nutrition log. Return JSON only.",
  "Each photo may show several foods. Return every visible food in that photo, including packaged products. Do not stop after the first item.",
  "Read the brand, the product name, and the net weight from any label you can see.",
  "Tell raw recipe ingredients apart from a plated, already cooked dish. List raw ingredients separately. For a plated meal, list the foods on the plate.",
  "Use the plate, board, knife, or package for scale. Prefer a labeled net weight. Account for raw versus cooked weight, and put raw or cooked in the name when it changes the number.",
  "nutrients are for the gram amount, not per 100 g. Use realistic numbers, never a placeholder of all zeros. fiber_g is null when you cannot tell, and 0 only when the food has no fiber.",
  "You may also send per100g with the same keys. If portion nutrients are missing, the server scales per100g by grams/100.",
  "confidence is 0 to 1. uncertainty is optional, 0 to 1, and higher when the portion is a guess.",
  'Shape: {"ingredients":[{"photoIndex":0,"name":"S&B Golden Curry sauce mix, 92 g box","grams":92,"nutrients":{"kcal":344,"protein_g":5.5,"carbs_g":52,"fat_g":12,"fiber_g":3},"confidence":0.86,"uncertainty":0.1},{"photoIndex":0,"name":"chicken breast, raw","grams":450,"nutrients":{"kcal":540,"protein_g":102,"carbs_g":0,"fat_g":12.6,"fiber_g":0},"confidence":0.7,"uncertainty":0.35}]}',
  "Do not include medical or dosing advice.",
].join("\n");

export async function estimatePhotos(
  photos: string[],
  note: string | null,
  fetchImpl: FetchLike = fetch,
  lookup: NutritionLookup = (name) => usdaPer100g(name, fetchImpl),
): Promise<EstimateIngredient[]> {
  const content: unknown[] = [
    {
      type: "text",
      text: [ESTIMATE_PROMPT, note ? `Note: ${note.slice(0, 1000)}` : "No note was provided."].join("\n"),
    },
    ...photos.map((url) => ({ type: "image_url", image_url: { url, detail: "high" } })),
  ];
  const text = await complete([{ role: "user", content }], fetchImpl);
  const parsed = parseEstimate(text, photos.length);
  return Promise.all(
    parsed.map(async (item) => {
      const filled = await fillNutrition(item, lookup);
      const { per100g: _per100g, ...rest } = item;
      return { ...rest, ...filled };
    }),
  );
}

export function parseLabel(text: string): { servingSize: string | null; servingsPerContainer: number | null; nutrients: LabelNutrients } {
  const record = jsonObject(text);
  const nutrients = readLabelNutrients(record.nutrients);
  if (!labelHasNutrient(nutrients)) throw new HttpError(502, "The estimate didn't come back");
  const servings = record.servingsPerContainer == null ? null : Number(record.servingsPerContainer);
  return {
    servingSize: typeof record.servingSize === "string" ? record.servingSize.trim().slice(0, 80) : null,
    servingsPerContainer: servings != null && Number.isFinite(servings) && servings > 0 ? round1(servings) : null,
    nutrients,
  };
}

export async function scanLabel(photo: string, fetchImpl: FetchLike = fetch) {
  const text = await complete(
    [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Read this nutrition label. Return JSON only.",
              '{"servingSize":"55 g","servingsPerContainer":8,"nutrients":{"kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0,"fiber_g":null}}',
              "nutrients are per serving. fiber_g is null when the label does not list fiber. Do not use 0 for a missing fiber value.",
            ].join("\n"),
          },
          { type: "image_url", image_url: { url: photo, detail: "high" } },
        ],
      },
    ],
    fetchImpl,
  );
  return parseLabel(text);
}

export type HelperIngredient = {
  name: string;
  grams: number;
  nutrients: Nutrients | null;
  source: string | null;
  uncertainty?: number;
  nutrition_missing?: true;
};

export function parseHelper(text: string): { ingredients: Array<DraftFood & { source: string | null; uncertainty?: number }>; questions: string[] } {
  const record = jsonObject(text);
  const questions = Array.isArray(record.questions)
    ? record.questions.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 200)).slice(0, 6)
    : [];
  const list = Array.isArray(record.ingredients) ? record.ingredients : [];
  const ingredients: Array<DraftFood & { source: string | null; uncertainty?: number }> = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim().slice(0, 120) : "";
    const grams = Number(row.grams);
    if (!name || !Number.isFinite(grams) || grams <= 0) continue;
    const uncertainty = optionalFraction(row.uncertainty);
    ingredients.push({
      name,
      grams: round1(grams),
      nutrients: optionalNutrients(row.nutrients),
      per100g: optionalNutrients(row.per100g),
      source: typeof row.source === "string" && row.source.trim() ? row.source.trim().slice(0, 40) : "ai",
      ...(uncertainty == null ? {} : { uncertainty }),
    });
  }
  return { ingredients, questions };
}

export async function helpRecipe(
  description: string,
  messages: { role: string; content: string }[] | undefined,
  fetchImpl: FetchLike = fetch,
  lookup: NutritionLookup = (name) => usdaPer100g(name, fetchImpl),
) {
  const history = (messages ?? [])
    .filter((item) => (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .slice(-8)
    .map((item) => ({ role: item.role, content: item.content.slice(0, 1000) }));
  const text = await complete(
    [
      ...history,
      {
        role: "user",
        content: [
          "Turn this homemade meal into an ingredient list. Return JSON only. Do not save anything.",
          "List every ingredient, including packaged products. Read brand, product, and net weight when the description includes a label.",
          "Keep raw ingredients distinct. nutrients are for the gram amount and must be realistic, not all zeros. fiber_g is null when unknown and 0 only when the food has no fiber.",
          "You may send per100g; the server scales it by grams/100 when portion nutrients are missing.",
          '{"ingredients":[{"name":"onion, raw","grams":150,"nutrients":{"kcal":60,"protein_g":1.7,"carbs_g":14,"fat_g":0.2,"fiber_g":2.6},"source":"ai"}],"questions":["Were the potatoes raw or cooked?"]}',
          "Ask at most 3 short questions only when a quantity is still ambiguous.",
          `Description: ${description.slice(0, 2000)}`,
        ].join("\n"),
      },
    ],
    fetchImpl,
  );
  const parsed = parseHelper(text);
  const ingredients: HelperIngredient[] = await Promise.all(
    parsed.ingredients.map(async (item) => {
      const filled = await fillNutrition(item, lookup);
      const { per100g: _per100g, source, ...rest } = item;
      return { ...rest, ...filled, source: filled.nutrition_missing ? source : macrosAreBlank(item.nutrients) && macrosAreBlank(item.per100g) ? "usda" : source };
    }),
  );
  return { ingredients, questions: parsed.questions };
}
