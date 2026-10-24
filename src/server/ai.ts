export type MealEstimate = {
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

export function parseMealEstimate(content: string): MealEstimate | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim().slice(0, 80) : "";
  const calories = asMacro(record.calories);
  const protein = asMacro(record.protein);
  const carbs = asMacro(record.carbs);
  const fat = asMacro(record.fat);
  if (!name || calories == null || protein == null || carbs == null || fat == null) return null;
  return { name, calories, protein, carbs, fat };
}

function asMacro(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number) || number < 0 || number > 20_000) return null;
  return Math.round(number);
}

export function aiConfigured(): boolean {
  return Boolean(process.env.AI_API_KEY?.trim());
}

export async function estimateMeal(input: {
  note: string;
  imageDataUrl?: string | null;
}): Promise<MealEstimate> {
  const key = process.env.AI_API_KEY?.trim();
  if (!key) {
    throw new Error("No AI key is set. Enter the meal yourself.");
  }
  const note = input.note.trim();
  const image = input.imageDataUrl?.trim() || "";
  if (!note && !image) throw new Error("Add a photo, a note, or both.");
  if (image && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=\s]+$/.test(image)) {
    throw new Error("That photo could not be read. Enter the meal yourself.");
  }
  if (image.length > 4_000_000) throw new Error("That photo is too large. Enter the meal yourself.");

  const base = (process.env.AI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.AI_MODEL?.trim() || "gpt-4o-mini";
  const prompt = [
    "Estimate this meal for a food log.",
    "Return JSON only with keys name, calories, protein, carbs, fat.",
    "calories is kcal. protein, carbs, and fat are grams. Use integers.",
    "Trust the note for portions and sauces. Use the photo together with the note when both are present.",
    "Do not include medical, insulin, or dosing advice.",
    note ? `Note: ${note}` : "No note was provided.",
  ].join("\n");

  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  if (image) content.push({ type: "image_url", image_url: { url: image } });

  const body = {
    model,
    temperature: 0.2,
    messages: [{ role: "user", content: image ? content : prompt }],
    response_format: { type: "json_object" },
  };

  let response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status === 400) {
    const { response_format: _ignored, ...withoutFormat } = body;
    response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(withoutFormat),
      signal: AbortSignal.timeout(30_000),
    });
  }
  if (!response.ok) throw new Error("The estimate didn't come back. Enter the meal yourself.");
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };
  const raw = payload.choices?.[0]?.message?.content;
  const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part) => part.text ?? "").join("\n") : "";
  const estimate = parseMealEstimate(text);
  if (!estimate) throw new Error("The estimate didn't come back. Enter the meal yourself.");
  return estimate;
}
