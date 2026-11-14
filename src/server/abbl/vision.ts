import { HttpError } from "../util";
import { readNutrients, round1, type Nutrients } from "./nutrients";

type FetchLike = typeof fetch;

export type EstimateIngredient = {
  photoIndex: number;
  name: string;
  grams: number;
  nutrients: Nutrients;
  confidence: number;
};

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

function confidence(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  const unit = number > 1 ? number / 100 : number;
  return round1(Math.min(1, unit));
}

export function parseEstimate(text: string, photoCount: number): EstimateIngredient[] {
  const record = jsonObject(text);
  const list = Array.isArray(record.ingredients) ? record.ingredients : [];
  const byIndex = new Map<number, EstimateIngredient>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const photoIndex = Number(row.photoIndex);
    if (!Number.isInteger(photoIndex) || photoIndex < 0 || photoIndex >= photoCount || byIndex.has(photoIndex)) continue;
    const name = typeof row.name === "string" ? row.name.trim().slice(0, 120) : "";
    const grams = Number(row.grams);
    if (!name || !Number.isFinite(grams) || grams <= 0) continue;
    try {
      byIndex.set(photoIndex, {
        photoIndex,
        name,
        grams: round1(grams),
        nutrients: readNutrients(row.nutrients),
        confidence: confidence(row.confidence),
      });
    } catch {
      /* Skip a photo the model didn't finish. */
    }
  }
  return [...byIndex.values()].sort((a, b) => a.photoIndex - b.photoIndex);
}

export async function estimatePhotos(photos: string[], note: string | null, fetchImpl: FetchLike = fetch): Promise<EstimateIngredient[]> {
  const content: unknown[] = [
    {
      type: "text",
      text: [
        "You estimate food for a nutrition log. Return JSON only.",
        "The user sent one JPEG per ingredient, in order. Return one ingredient per photo.",
        'Shape: {"ingredients":[{"photoIndex":0,"name":"","grams":0,"nutrients":{"kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0,"fiber_g":null},"confidence":0.8}]}',
        "nutrients are for the gram amount, not per 100 g. fiber_g is null when you cannot tell. confidence is 0 to 1.",
        "Do not include medical or dosing advice.",
        note ? `Note: ${note.slice(0, 1000)}` : "No note was provided.",
      ].join("\n"),
    },
    ...photos.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
  const text = await complete([{ role: "user", content }], fetchImpl);
  return parseEstimate(text, photos.length);
}

export function parseLabel(text: string): { servingSize: string | null; servingsPerContainer: number | null; nutrients: Nutrients } {
  const record = jsonObject(text);
  const servings = record.servingsPerContainer == null ? null : Number(record.servingsPerContainer);
  return {
    servingSize: typeof record.servingSize === "string" ? record.servingSize.trim().slice(0, 80) : null,
    servingsPerContainer: servings != null && Number.isFinite(servings) && servings > 0 ? round1(servings) : null,
    nutrients: readNutrients(record.nutrients),
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
          { type: "image_url", image_url: { url: photo } },
        ],
      },
    ],
    fetchImpl,
  );
  return parseLabel(text);
}

export function parseHelper(text: string): { ingredients: IngredientGuess[]; questions: string[] } {
  const record = jsonObject(text);
  const questions = Array.isArray(record.questions)
    ? record.questions.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 200)).slice(0, 6)
    : [];
  const list = Array.isArray(record.ingredients) ? record.ingredients : [];
  const ingredients: IngredientGuess[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    try {
      const ingredient = readIngredient(item);
      ingredients.push({ ...ingredient, source: ingredient.source ?? "ai" });
    } catch {
      /* Skip a row the model didn't finish. */
    }
  }
  return { ingredients, questions };
}

type IngredientGuess = { name: string; grams: number; nutrients: Nutrients; source: string | null };

function readIngredient(value: unknown) {
  const row = value as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim().slice(0, 120) : "";
  const grams = Number(row.grams);
  if (!name || !Number.isFinite(grams) || grams <= 0) throw new Error("skip");
  return { name, grams: round1(grams), nutrients: readNutrients(row.nutrients), source: typeof row.source === "string" ? row.source : "ai" };
}

export async function helpRecipe(description: string, messages: { role: string; content: string }[] | undefined, fetchImpl: FetchLike = fetch) {
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
          '{"ingredients":[{"name":"","grams":0,"nutrients":{"kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0,"fiber_g":null},"source":"ai"}],"questions":[""]}',
          "nutrients are for the gram amount. fiber_g is null when unknown. Ask at most 3 short questions only when a quantity is still ambiguous.",
          `Description: ${description.slice(0, 2000)}`,
        ].join("\n"),
      },
    ],
    fetchImpl,
  );
  return parseHelper(text);
}
