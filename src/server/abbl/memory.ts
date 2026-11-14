import { randomUUID } from "crypto";
import type { Nutrients } from "./nutrients";
import type { AbblStore, AbblUser, Invite, MealRecord, NewMeal, NewRecipe, RecipeRecord, SteadyFavorite } from "./records";

type CodeRow = { email: string; codeHash: string; expiresAt: number; used: boolean };
type TokenRow = { userId: string; tokenHash: string; revoked: boolean };

export class MemoryAbblStore implements AbblStore {
  allowList = new Set<string>();
  users = new Map<string, AbblUser>();
  codes: CodeRow[] = [];
  tokens: TokenRow[] = [];
  targets = new Map<string, Nutrients>();
  recipes = new Map<string, { userId: string; recipe: RecipeRecord }>();
  meals = new Map<string, { userId: string; meal: MealRecord }>();
  favorites: SteadyFavorite[] = [];

  async isAllowed(email: string): Promise<boolean> {
    return this.allowList.has(email);
  }

  async allow(email: string): Promise<void> {
    this.allowList.add(email);
    await this.enableUser(email);
  }

  async unallow(email: string): Promise<boolean> {
    return this.allowList.delete(email);
  }

  async listInvites(): Promise<Invite[]> {
    return [...this.allowList].sort().map((email) => {
      const user = [...this.users.values()].find((item) => item.email === email) ?? null;
      const status = !user ? "invited" : user.disabled ? "disabled" : "joined";
      return { email, status, userId: user?.id ?? null };
    });
  }

  async saveCode(email: string, codeHash: string, expiresAt: Date): Promise<void> {
    this.codes.push({ email, codeHash, expiresAt: expiresAt.getTime(), used: false });
  }

  async consumeCode(email: string, codeHash: string, now: Date): Promise<boolean> {
    const row = [...this.codes].reverse().find((item) => item.email === email && item.codeHash === codeHash && !item.used && item.expiresAt > now.getTime());
    if (!row) return false;
    row.used = true;
    return true;
  }

  async userByEmail(email: string): Promise<AbblUser | null> {
    return [...this.users.values()].find((user) => user.email === email) ?? null;
  }

  async userById(id: string): Promise<AbblUser | null> {
    return this.users.get(id) ?? null;
  }

  async createUser(email: string): Promise<AbblUser> {
    const user = { id: randomUUID(), email, disabled: false };
    this.users.set(user.id, user);
    return user;
  }

  async disableUser(id: string): Promise<boolean> {
    const user = this.users.get(id);
    if (!user) return false;
    user.disabled = true;
    await this.revokeUserTokens(id);
    return true;
  }

  async enableUser(email: string): Promise<void> {
    const user = await this.userByEmail(email);
    if (user) user.disabled = false;
  }

  async saveToken(userId: string, tokenHash: string): Promise<void> {
    this.tokens.push({ userId, tokenHash, revoked: false });
  }

  async userForToken(tokenHash: string): Promise<AbblUser | null> {
    const token = this.tokens.find((item) => item.tokenHash === tokenHash && !item.revoked);
    if (!token) return null;
    const user = this.users.get(token.userId);
    if (!user || user.disabled) return null;
    return user;
  }

  async revokeToken(tokenHash: string): Promise<void> {
    const token = this.tokens.find((item) => item.tokenHash === tokenHash);
    if (token) token.revoked = true;
  }

  async revokeUserTokens(userId: string): Promise<void> {
    for (const token of this.tokens) {
      if (token.userId === userId) token.revoked = true;
    }
  }

  async getTargets(userId: string): Promise<Nutrients | null> {
    return this.targets.get(userId) ?? null;
  }

  async putTargets(userId: string, targets: Nutrients): Promise<Nutrients> {
    this.targets.set(userId, targets);
    return targets;
  }

  async listRecipes(userId: string): Promise<RecipeRecord[]> {
    return [...this.recipes.values()].filter((row) => row.userId === userId).map((row) => row.recipe);
  }

  async getRecipe(userId: string, id: string): Promise<RecipeRecord | null> {
    const row = this.recipes.get(id);
    if (!row || row.userId !== userId) return null;
    return row.recipe;
  }

  async insertRecipe(userId: string, recipe: NewRecipe): Promise<RecipeRecord> {
    const saved = { id: randomUUID(), ...recipe, ingredients: recipe.ingredients.map((item) => ({ ...item, nutrients: { ...item.nutrients } })) };
    this.recipes.set(saved.id, { userId, recipe: saved });
    return saved;
  }

  async updateRecipe(userId: string, id: string, recipe: NewRecipe): Promise<RecipeRecord | null> {
    const existing = await this.getRecipe(userId, id);
    if (!existing) return null;
    const saved = { id, ...recipe };
    this.recipes.set(id, { userId, recipe: saved });
    return saved;
  }

  async deleteRecipe(userId: string, id: string): Promise<boolean> {
    const existing = await this.getRecipe(userId, id);
    if (!existing) return false;
    this.recipes.delete(id);
    return true;
  }

  async copyRecipe(fromUserId: string, recipeId: string, toUserId: string): Promise<RecipeRecord | null> {
    const recipe = await this.getRecipe(fromUserId, recipeId);
    if (!recipe) return null;
    return this.insertRecipe(toUserId, {
      name: recipe.name,
      ingredients: recipe.ingredients.map((item) => ({ ...item, nutrients: { ...item.nutrients } })),
      yieldGrams: recipe.yieldGrams,
      servings: recipe.servings,
      notes: recipe.notes,
    });
  }

  async listMeals(userId: string, date: string): Promise<MealRecord[]> {
    return [...this.meals.values()].filter((row) => row.userId === userId && row.meal.date === date).map((row) => row.meal);
  }

  async getMeal(userId: string, id: string): Promise<MealRecord | null> {
    const row = this.meals.get(id);
    if (!row || row.userId !== userId) return null;
    return row.meal;
  }

  async insertMeal(userId: string, meal: NewMeal): Promise<MealRecord> {
    const saved = { id: randomUUID(), ...meal };
    this.meals.set(saved.id, { userId, meal: saved });
    return saved;
  }

  async updateMeal(userId: string, id: string, meal: NewMeal): Promise<MealRecord | null> {
    const existing = await this.getMeal(userId, id);
    if (!existing) return null;
    const saved = { id, ...meal };
    this.meals.set(id, { userId, meal: saved });
    return saved;
  }

  async deleteMeal(userId: string, id: string): Promise<boolean> {
    const existing = await this.getMeal(userId, id);
    if (!existing) return false;
    this.meals.delete(id);
    return true;
  }

  async insertSteadyFavorite(entry: Omit<SteadyFavorite, "id">): Promise<SteadyFavorite> {
    const saved = { id: randomUUID(), ...entry };
    this.favorites.push(saved);
    return saved;
  }
}
