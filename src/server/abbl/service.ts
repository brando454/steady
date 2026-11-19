import { createHash, randomBytes, randomInt } from "crypto";
import { secretsMatch } from "../auth";
import { HttpError, cleanText, readDate } from "../util";
import { MEAL_TYPES, perServing, readIngredient, scaleIngredient, totalNutrients, type Ingredient, type MealType } from "./nutrients";
import type { AbblStore, AbblUser, InviteRecord, InviteStatus, MealRecord, NewRecipe, RecipeRecord } from "./records";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newInviteCode(): string {
  const chars = Array.from({ length: 12 }, () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}

export function codeHash(code: string): string {
  const normalized = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return createHash("sha256").update(normalized).digest("hex");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function setupCodeMatches(presented: string): boolean {
  const expected = process.env.ABBL_ADMIN_SETUP_CODE?.trim() ?? "";
  const given = presented.trim();
  if (!expected || !given) return false;
  return secretsMatch(given, expected);
}

export function readPersonName(value: unknown, required: boolean): string | null {
  if (value == null || value === "") {
    if (required) throw new HttpError(400, "Name is missing");
    return null;
  }
  if (typeof value !== "string") throw new HttpError(400, "Name looks off");
  const name = value.trim();
  if (!name || name.length > 80) throw new HttpError(400, "Name looks off");
  return name;
}

export function readOptionalEmail(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, "Email looks off");
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new HttpError(400, "Email looks off");
  return email;
}

export function inviteStatus(invite: InviteRecord, now: Date): InviteStatus {
  if (invite.revokedAt) return "revoked";
  if (invite.usedAt) return "used";
  if (Date.parse(invite.expiresAt) <= now.getTime()) return "expired";
  return "pending";
}

export function presentInvite(invite: InviteRecord, now: Date) {
  return {
    id: invite.id,
    name: invite.name,
    email: invite.email,
    userId: invite.userId,
    status: inviteStatus(invite, now),
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
  };
}

export function publicUser(user: AbblUser): { id: string; name: string; email: string | null; admin: boolean } {
  return { id: user.id, name: user.name, email: user.email, admin: user.admin };
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
  return { id: meal.id, date: meal.date, time: meal.time, meal: meal.meal, items: meal.items, totals };
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

/** Any real civil date from 2000-01-01 through the day after `now`. Past days are allowed. */
export function readLoggedDate(value: unknown, now: Date): string {
  const date = readDate(value);
  const [year, month, day] = date.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  const real = check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
  const latest = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (!real || date < "2000-01-01" || date > latest) throw new HttpError(400, "Pick a date");
  return date;
}

export function readMealType(value: unknown): MealType | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, "meal looks off");
  const meal = value.trim().toLowerCase();
  if (!(MEAL_TYPES as readonly string[]).includes(meal)) throw new HttpError(400, "meal looks off");
  return meal as MealType;
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

export function readMealMeta(body: Record<string, unknown>, now: Date): { date: string; time: string; meal: MealType | null } {
  return { date: readLoggedDate(body.date, now), time: readTime(body.time), meal: readMealType(body.meal) };
}

export async function requireUser(store: AbblStore, header: string | undefined): Promise<AbblUser> {
  const match = /^Bearer\s+(\S+)$/i.exec((header ?? "").trim());
  const token = match?.[1]?.trim() ?? "";
  if (!token) throw new HttpError(401, "Sign in required");
  const user = await store.userForToken(tokenHash(token));
  if (!user) throw new HttpError(401, "Sign in required");
  return user;
}

export function assertAdmin(user: AbblUser): void {
  if (!user.admin) throw new HttpError(403, "Admin only");
}
