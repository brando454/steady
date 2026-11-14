import { HttpError } from "../util";
import { round1, type Nutrients } from "./nutrients";

export type FoodHit = {
  id: string;
  name: string;
  source: "usda" | "open_food_facts" | "spoonacular";
  restaurant?: string;
  per100g: Nutrients | null;
  serving: { label: string | null; grams: number | null };
  perServing: Nutrients | null;
};

type FetchLike = typeof fetch;

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function nutrients(kcal: number | null, protein: number | null, carbs: number | null, fat: number | null, fiber: number | null): Nutrients | null {
  if (kcal == null || protein == null || carbs == null || fat == null) return null;
  return { kcal: round1(kcal), protein_g: round1(protein), carbs_g: round1(carbs), fat_g: round1(fat), fiber_g: fiber == null ? null : round1(fiber) };
}

function scale(base: Nutrients, factor: number): Nutrients {
  return {
    kcal: round1(base.kcal * factor),
    protein_g: round1(base.protein_g * factor),
    carbs_g: round1(base.carbs_g * factor),
    fat_g: round1(base.fat_g * factor),
    fiber_g: base.fiber_g == null ? null : round1(base.fiber_g * factor),
  };
}

function pair(amount: Nutrients, grams: number | null, amountIsPer100g: boolean): { per100g: Nutrients | null; perServing: Nutrients | null } {
  if (amountIsPer100g) {
    return { per100g: amount, perServing: grams ? scale(amount, grams / 100) : null };
  }
  return { per100g: grams ? scale(amount, 100 / grams) : null, perServing: amount };
}

function usdaValue(food: Record<string, unknown>, ids: number[]): number | null {
  const list = Array.isArray(food.foodNutrients) ? food.foodNutrients : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = Number(row.nutrientId ?? (row.nutrient as { id?: number } | undefined)?.id);
    if (!ids.includes(id)) continue;
    return num(row.value ?? row.amount);
  }
  return null;
}

function servingGrams(size: unknown, unit: unknown): number | null {
  const amount = num(size);
  if (amount == null || amount <= 0) return null;
  const label = String(unit ?? "g").trim().toLowerCase();
  if (label === "g" || label === "grm" || label === "gram" || label === "grams" || label === "ml") return amount;
  if (label === "oz" || label === "ounce" || label === "ounces") return round1(amount * 28.3495);
  return null;
}

export function parseUsdaFoods(payload: unknown): FoodHit[] {
  const foods = payload && typeof payload === "object" && Array.isArray((payload as { foods?: unknown }).foods)
    ? (payload as { foods: unknown[] }).foods
    : [];
  const hits: FoodHit[] = [];
  for (const item of foods) {
    if (!item || typeof item !== "object") continue;
    const food = item as Record<string, unknown>;
    const kcal = usdaValue(food, [1008]);
    const protein = usdaValue(food, [1003]);
    const carbs = usdaValue(food, [1005]);
    const fat = usdaValue(food, [1004]);
    const fiber = usdaValue(food, [1079]);
    const parsed = nutrients(kcal, protein, carbs, fat, fiber);
    if (!parsed || food.fdcId == null) continue;
    const branded = String(food.dataType ?? "").toLowerCase() === "branded";
    const grams = servingGrams(food.servingSize, food.servingSizeUnit);
    const paired = pair(parsed, grams, !branded);
    const description = [food.brandName, food.description].filter((part) => typeof part === "string" && part.trim()).join(" ");
    hits.push({
      id: `usda:${food.fdcId}`,
      name: description || "Food",
      source: "usda",
      per100g: paired.per100g,
      serving: { label: typeof food.householdServingFullText === "string" ? food.householdServingFullText : grams ? `${grams} g` : null, grams },
      perServing: paired.perServing,
    });
  }
  return hits;
}

export function parseOpenFoodFacts(payload: unknown, upc: string): FoodHit | null {
  if (!payload || typeof payload !== "object") return null;
  const product = (payload as { product?: Record<string, unknown> }).product;
  if (!product || typeof product !== "object") return null;
  const nutriments = (product.nutriments ?? {}) as Record<string, unknown>;
  const parsed = nutrients(
    num(nutriments["energy-kcal_100g"]),
    num(nutriments.proteins_100g),
    num(nutriments.carbohydrates_100g),
    num(nutriments.fat_100g),
    nutriments.fiber_100g == null ? null : num(nutriments.fiber_100g),
  );
  if (!parsed) return null;
  const servingText = typeof product.serving_size === "string" ? product.serving_size : null;
  const grams = servingText ? servingGrams(servingText.match(/[\d.]+/)?.[0], servingText.match(/[a-zA-Z]+/)?.[0] ?? "g") : null;
  const paired = pair(parsed, grams, true);
  return {
    id: `off:${upc}`,
    name: typeof product.product_name === "string" && product.product_name.trim() ? product.product_name.trim() : "Packaged food",
    source: "open_food_facts",
    per100g: paired.per100g,
    serving: { label: servingText, grams },
    perServing: paired.perServing,
  };
}

function spoonNutrient(list: unknown[], names: string[]): number | null {
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = String(row.name ?? "").toLowerCase();
    if (!names.some((needle) => name.includes(needle))) continue;
    return num(row.amount);
  }
  return null;
}

export function parseSpoonacular(payload: unknown): FoodHit[] {
  const items = payload && typeof payload === "object" && Array.isArray((payload as { menuItems?: unknown }).menuItems)
    ? (payload as { menuItems: unknown[] }).menuItems
    : [];
  const hits: FoodHit[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const nutrition = (row.nutrition ?? {}) as { nutrients?: unknown[] };
    const list = Array.isArray(nutrition.nutrients) ? nutrition.nutrients : [];
    const parsed = nutrients(
      spoonNutrient(list, ["calorie"]),
      spoonNutrient(list, ["protein"]),
      spoonNutrient(list, ["carbohydrate"]),
      spoonNutrient(list, ["fat"]),
      list.some((nutrient) => nutrient && typeof nutrient === "object" && String((nutrient as { name?: string }).name ?? "").toLowerCase().includes("fiber"))
        ? spoonNutrient(list, ["fiber"])
        : null,
    );
    if (!parsed || row.id == null) continue;
    const grams = num((row.servingSize as { size?: unknown } | undefined)?.size ?? row.servingSizeGrams) ;
    const paired = pair(parsed, grams, false);
    hits.push({
      id: `spoonacular:${row.id}`,
      name: typeof row.title === "string" ? row.title : "Menu item",
      source: "spoonacular",
      restaurant: typeof row.restaurantChain === "string" ? row.restaurantChain : undefined,
      per100g: paired.per100g,
      serving: { label: grams ? `${grams} g` : null, grams },
      perServing: paired.perServing,
    });
  }
  return hits;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new HttpError(502, "The food lookup didn't come back");
  return response.json() as Promise<unknown>;
}

export async function searchUsda(query: string, fetchImpl: FetchLike = fetch): Promise<FoodHit[]> {
  const key = process.env.USDA_API_KEY?.trim();
  if (!key) throw new HttpError(503, "Food search is not configured");
  const url = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
  url.searchParams.set("api_key", key);
  url.searchParams.set("query", query);
  url.searchParams.set("pageSize", "10");
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  return parseUsdaFoods(await readJson(response));
}

export async function lookupBarcode(upc: string, fetchImpl: FetchLike = fetch): Promise<FoodHit | null> {
  const key = process.env.USDA_API_KEY?.trim();
  if (!key) throw new HttpError(503, "Barcode lookup is not configured");
  const url = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
  url.searchParams.set("api_key", key);
  url.searchParams.set("query", upc);
  url.searchParams.set("dataType", "Branded");
  url.searchParams.set("pageSize", "5");
  const usda = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  const branded = parseUsdaFoods(await readJson(usda))[0];
  if (branded) return branded;
  const off = await fetchImpl(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(upc)}.json`, {
    headers: { "User-Agent": "ABBL/1.0 (Steady)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (off.status === 404) return null;
  if (!off.ok) throw new HttpError(502, "The food lookup didn't come back");
  return parseOpenFoodFacts(await off.json(), upc);
}

export async function searchRestaurants(query: string, fetchImpl: FetchLike = fetch): Promise<FoodHit[]> {
  const key = process.env.SPOONACULAR_API_KEY?.trim();
  if (!key) throw new HttpError(503, "Restaurant search is not configured");
  const url = new URL("https://api.spoonacular.com/food/menuItems/search");
  url.searchParams.set("apiKey", key);
  url.searchParams.set("query", query);
  url.searchParams.set("number", "8");
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  return parseSpoonacular(await readJson(response));
}
