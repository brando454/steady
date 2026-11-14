import { createHash, randomBytes, randomInt } from "crypto";
import { HttpError, cleanText, readDate } from "../util";
import { perServing, readIngredient, scaleIngredient, totalNutrients, type Ingredient, type Nutrients } from "./nutrients";
import type { AbblStore, AbblUser, MealRecord, NewMeal, NewRecipe, RecipeRecord } from "./records";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const START_BODY = { ok: true };

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return null;
  return email;
}

export function codeHash(email: string, code: string): string {
  return createHash("sha256").update(`${email}:${code}`).digest("hex");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function publicUser(user: AbblUser, adminEmail: string | null): { id: string; email: string; admin: boolean } {
  return { id: user.id, email: user.email, admin: adminEmail != null && user.email === adminEmail };
}

export function presentRecipe(recipe: RecipeRecord) {
  const totals = totalNutrients(recipe.ingredients.map((item) => item.nutrients));
  return {
    id: recipe.id,
    name: recipe.name,
    ingredients: recipe.ingredients,
    yieldGrams: recipe.yieldGrams,
    servings: recipe.servings,
    notes: recipe.notes,
    totals,
    perServing: perServing(totals, recipe.servings),
  };
}

export function presentMeal(meal: MealRecord) {
  const totals = totalNutrients(meal.items.map((item) => item.nutrients));
  return { id: meal.id, date: meal.date, time: meal.time, items: meal.items, totals };
}

export function readRecipeBody(body: Record<string, unknown>): NewRecipe {
  const name = cleanText(body.name, "Name", 120);
  const servings = Number(body.servings);
  if (!Number.isFinite(servings) || servings <= 0 || servings > 100) throw new HttpError(400, "servings looks off");
  const notes = body.notes == null || body.notes === "" ? null : cleanText(body.notes, "Notes", 2000, false) || null;
  let yieldGrams: number | null = null;
  if (body.yieldGrams != null && body.yieldGrams !== "") {
    const grams = Number(body.yieldGrams);
    if (!Number.isFinite(grams) || grams <= 0 || grams > 100_000) throw new HttpError(400, "yieldGrams looks off");
    yieldGrams = Math.round(grams * 10) / 10;
  }
  if (!Array.isArray(body.ingredients) || body.ingredients.length < 1 || body.ingredients.length > 80) {
    throw new HttpError(400, "Add at least one ingredient");
  }
  return { name, servings, notes, yieldGrams, ingredients: body.ingredients.map(readIngredient) };
}

export function readTime(value: unknown): string {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new HttpError(400, "Pick a time");
  return value;
}

export async function itemsFromMealBody(store: AbblStore, userId: string, body: Record<string, unknown>): Promise<Ingredient[]> {
  const hasItems = Array.isArray(body.items);
  const hasRecipe = typeof body.recipeId === "string" && body.recipeId.length > 0;
  if (hasItems === hasRecipe) throw new HttpError(400, "Send items or a recipe, not both");
  if (hasItems) {
    const items = body.items as unknown[];
    if (items.length < 1 || items.length > 80) throw new HttpError(400, "Add at least one item");
    return items.map(readIngredient);
  }
  const recipe = await store.getRecipe(userId, String(body.recipeId));
  if (!recipe) throw new HttpError(404, "Recipe not found");
  const servings = body.servings == null || body.servings === "" ? null : Number(body.servings);
  const grams = body.grams == null || body.grams === "" ? null : Number(body.grams);
  if ((servings == null) === (grams == null)) throw new HttpError(400, "Send servings or grams");
  let factor: number;
  if (servings != null) {
    if (!Number.isFinite(servings) || servings <= 0) throw new HttpError(400, "servings looks off");
    factor = servings / recipe.servings;
  } else {
    if (!recipe.yieldGrams) throw new HttpError(400, "This recipe has no cooked weight");
    if (!Number.isFinite(grams) || (grams ?? 0) <= 0) throw new HttpError(400, "grams looks off");
    factor = (grams as number) / recipe.yieldGrams;
  }
  return recipe.ingredients.map((item) => scaleIngredient(item, factor));
}

export function readMealMeta(body: Record<string, unknown>): { date: string; time: string } {
  return { date: readDate(body.date), time: readTime(body.time) };
}

export async function requireUser(store: AbblStore, header: string | undefined): Promise<AbblUser> {
  const match = /^Bearer\s+(\S+)$/i.exec((header ?? "").trim());
  const token = match?.[1]?.trim() ?? "";
  if (!token) throw new HttpError(401, "Sign in required");
  const user = await store.userForToken(tokenHash(token));
  if (!user) throw new HttpError(401, "Sign in required");
  return user;
}

export function adminEmail(): string | null {
  const email = process.env.ABBL_ADMIN_EMAIL?.trim().toLowerCase() ?? "";
  return email || null;
}

export function assertAdmin(user: AbblUser): void {
  const email = adminEmail();
  if (!email) throw new HttpError(503, "ABBL admin is not configured");
  if (user.email !== email) throw new HttpError(403, "Admin only");
}
