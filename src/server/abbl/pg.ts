import { randomUUID } from "crypto";
import { pool, rows, tx, type Queryable } from "../db";
import type { Ingredient, Nutrients } from "./nutrients";
import type { AbblStore, AbblUser, InviteRecord, MealRecord, NewInvite, NewMeal, NewRecipe, NewUser, RecipeRecord, SteadyFavorite } from "./records";

type UserRow = { id: string; name: string; email: string | null; admin: boolean; disabled_at: Date | null };
type InviteRow = {
  id: string;
  code_hash: string;
  name: string;
  email: string | null;
  user_id: string | null;
  created_by: string | null;
  expires_at: Date | string;
  used_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
};
type IngredientRow = {
  sort_order: number;
  name: string;
  grams: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number | null;
  source: string | null;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function userOf(row: UserRow): AbblUser {
  return { id: row.id, name: row.name, email: row.email, admin: row.admin, disabled: row.disabled_at != null };
}

function inviteOf(row: InviteRow): InviteRecord {
  return {
    id: row.id,
    codeHash: row.code_hash,
    name: row.name,
    email: row.email,
    userId: row.user_id,
    createdBy: row.created_by,
    expiresAt: iso(row.expires_at),
    usedAt: row.used_at == null ? null : iso(row.used_at),
    revokedAt: row.revoked_at == null ? null : iso(row.revoked_at),
    createdAt: iso(row.created_at),
  };
}

const USER_COLUMNS = "id, name, email, admin, disabled_at";

function ingredientOf(row: IngredientRow): Ingredient {
  return {
    name: row.name,
    grams: Number(row.grams),
    nutrients: {
      kcal: Number(row.kcal),
      protein_g: Number(row.protein_g),
      carbs_g: Number(row.carbs_g),
      fat_g: Number(row.fat_g),
      fiber_g: row.fiber_g == null ? null : Number(row.fiber_g),
    },
    source: row.source,
  };
}

export class PgAbblStore implements AbblStore {
  constructor(private readonly db: Queryable = pool) {}

  async findAdmin(): Promise<AbblUser | null> {
    const found = await rows<UserRow>(this.db, `SELECT ${USER_COLUMNS} FROM abbl_users WHERE admin = true LIMIT 1`);
    return found[0] ? userOf(found[0]) : null;
  }

  async userById(id: string): Promise<AbblUser | null> {
    const found = await rows<UserRow>(this.db, `SELECT ${USER_COLUMNS} FROM abbl_users WHERE id = $1`, [id]);
    return found[0] ? userOf(found[0]) : null;
  }

  async createUser(input: NewUser): Promise<AbblUser> {
    const id = randomUUID();
    const found = await rows<UserRow>(
      this.db,
      `INSERT INTO abbl_users (id, name, email, admin) VALUES ($1,$2,$3,$4) RETURNING ${USER_COLUMNS}`,
      [id, input.name, input.email, input.admin],
    );
    return userOf(found[0]);
  }

  async updateName(id: string, name: string): Promise<AbblUser | null> {
    const found = await rows<UserRow>(this.db, `UPDATE abbl_users SET name = $2 WHERE id = $1 RETURNING ${USER_COLUMNS}`, [id, name]);
    return found[0] ? userOf(found[0]) : null;
  }

  async listUsers(): Promise<AbblUser[]> {
    const found = await rows<UserRow>(this.db, `SELECT ${USER_COLUMNS} FROM abbl_users ORDER BY created_at`);
    return found.map(userOf);
  }

  async disableUser(id: string): Promise<boolean> {
    const result = await this.db.query("UPDATE abbl_users SET disabled_at = now() WHERE id = $1", [id]);
    if ((result.rowCount ?? 0) === 0) return false;
    await this.revokeUserTokens(id);
    return true;
  }

  async enableUser(id: string): Promise<void> {
    await this.db.query("UPDATE abbl_users SET disabled_at = NULL WHERE id = $1", [id]);
  }

  async insertInvite(invite: NewInvite): Promise<InviteRecord> {
    const found = await rows<InviteRow>(
      this.db,
      `INSERT INTO abbl_invites (id, code_hash, name, email, user_id, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, code_hash, name, email, user_id, created_by, expires_at, used_at, revoked_at, created_at`,
      [randomUUID(), invite.codeHash, invite.name, invite.email, invite.userId, invite.createdBy, invite.expiresAt],
    );
    return inviteOf(found[0]);
  }

  async listInvites(): Promise<InviteRecord[]> {
    const found = await rows<InviteRow>(
      this.db,
      `SELECT id, code_hash, name, email, user_id, created_by, expires_at, used_at, revoked_at, created_at
       FROM abbl_invites ORDER BY created_at`,
    );
    return found.map(inviteOf);
  }

  async revokeInvite(id: string): Promise<boolean> {
    const result = await this.db.query("UPDATE abbl_invites SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND used_at IS NULL", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async consumeInvite(codeHash: string, now: Date): Promise<InviteRecord | null> {
    const found = await rows<InviteRow>(
      this.db,
      `UPDATE abbl_invites SET used_at = $2
       WHERE id = (
         SELECT id FROM abbl_invites
         WHERE code_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $2
         LIMIT 1
       )
       RETURNING id, code_hash, name, email, user_id, created_by, expires_at, used_at, revoked_at, created_at`,
      [codeHash, now],
    );
    return found[0] ? inviteOf(found[0]) : null;
  }

  async linkInviteUser(inviteId: string, userId: string): Promise<void> {
    await this.db.query("UPDATE abbl_invites SET user_id = $2 WHERE id = $1 AND user_id IS NULL", [inviteId, userId]);
  }

  async saveToken(userId: string, tokenHash: string): Promise<void> {
    await this.db.query("INSERT INTO abbl_tokens (id, user_id, token_hash) VALUES ($1,$2,$3)", [randomUUID(), userId, tokenHash]);
  }

  async userForToken(tokenHash: string): Promise<AbblUser | null> {
    const found = await rows<UserRow>(
      this.db,
      `SELECT u.id, u.name, u.email, u.admin, u.disabled_at
       FROM abbl_tokens t
       JOIN abbl_users u ON u.id = t.user_id
       WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND u.disabled_at IS NULL`,
      [tokenHash],
    );
    return found[0] ? userOf(found[0]) : null;
  }

  async revokeToken(tokenHash: string): Promise<void> {
    await this.db.query("UPDATE abbl_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [tokenHash]);
  }

  async revokeUserTokens(userId: string): Promise<void> {
    await this.db.query("UPDATE abbl_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
  }

  async getTargets(userId: string): Promise<Nutrients | null> {
    const found = await rows<Nutrients>(
      this.db,
      "SELECT kcal, protein_g, carbs_g, fat_g, fiber_g FROM abbl_targets WHERE user_id = $1",
      [userId],
    );
    if (!found[0]) return null;
    return {
      kcal: Number(found[0].kcal),
      protein_g: Number(found[0].protein_g),
      carbs_g: Number(found[0].carbs_g),
      fat_g: Number(found[0].fat_g),
      fiber_g: Number(found[0].fiber_g),
    };
  }

  async putTargets(userId: string, targets: Nutrients): Promise<Nutrients> {
    await this.db.query(
      `INSERT INTO abbl_targets (user_id, kcal, protein_g, carbs_g, fat_g, fiber_g, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (user_id) DO UPDATE SET
         kcal = EXCLUDED.kcal, protein_g = EXCLUDED.protein_g, carbs_g = EXCLUDED.carbs_g,
         fat_g = EXCLUDED.fat_g, fiber_g = EXCLUDED.fiber_g, updated_at = now()`,
      [userId, targets.kcal, targets.protein_g, targets.carbs_g, targets.fat_g, targets.fiber_g],
    );
    return targets;
  }

  private async ingredients(userId: string, recipeIds: string[]): Promise<Map<string, IngredientRow[]>> {
    const grouped = new Map<string, IngredientRow[]>();
    if (!recipeIds.length) return grouped;
    const found = await rows<IngredientRow & { recipe_id: string }>(
      this.db,
      `SELECT recipe_id, sort_order, name, grams, kcal, protein_g, carbs_g, fat_g, fiber_g, source
       FROM abbl_recipe_ingredients
       WHERE user_id = $1 AND recipe_id = ANY($2::uuid[])
       ORDER BY sort_order`,
      [userId, recipeIds],
    );
    for (const row of found) {
      const list = grouped.get(row.recipe_id) ?? [];
      list.push(row);
      grouped.set(row.recipe_id, list);
    }
    return grouped;
  }

  private recipeFrom(row: { id: string; name: string; yield_grams: number | null; servings: number; notes: string | null }, ingredients: IngredientRow[]): RecipeRecord {
    return {
      id: row.id,
      name: row.name,
      yieldGrams: row.yield_grams == null ? null : Number(row.yield_grams),
      servings: Number(row.servings),
      notes: row.notes,
      ingredients: ingredients.map(ingredientOf),
    };
  }

  async listRecipes(userId: string): Promise<RecipeRecord[]> {
    const found = await rows<{ id: string; name: string; yield_grams: number | null; servings: number; notes: string | null }>(
      this.db,
      "SELECT id, name, yield_grams, servings, notes FROM abbl_recipes WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    const ingredients = await this.ingredients(userId, found.map((row) => row.id));
    return found.map((row) => this.recipeFrom(row, ingredients.get(row.id) ?? []));
  }

  async getRecipe(userId: string, id: string): Promise<RecipeRecord | null> {
    const found = await rows<{ id: string; name: string; yield_grams: number | null; servings: number; notes: string | null }>(
      this.db,
      "SELECT id, name, yield_grams, servings, notes FROM abbl_recipes WHERE user_id = $1 AND id = $2",
      [userId, id],
    );
    if (!found[0]) return null;
    const ingredients = await this.ingredients(userId, [id]);
    return this.recipeFrom(found[0], ingredients.get(id) ?? []);
  }

  private async writeIngredients(client: Queryable, userId: string, recipeId: string, ingredients: Ingredient[]): Promise<void> {
    await client.query("DELETE FROM abbl_recipe_ingredients WHERE user_id = $1 AND recipe_id = $2", [userId, recipeId]);
    for (let index = 0; index < ingredients.length; index += 1) {
      const item = ingredients[index];
      await client.query(
        `INSERT INTO abbl_recipe_ingredients (
           id, recipe_id, user_id, sort_order, name, grams, kcal, protein_g, carbs_g, fat_g, fiber_g, source
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          randomUUID(),
          recipeId,
          userId,
          index,
          item.name,
          item.grams,
          item.nutrients.kcal,
          item.nutrients.protein_g,
          item.nutrients.carbs_g,
          item.nutrients.fat_g,
          item.nutrients.fiber_g,
          item.source,
        ],
      );
    }
  }

  async insertRecipe(userId: string, recipe: NewRecipe): Promise<RecipeRecord> {
    const id = randomUUID();
    await tx(async (client) => {
      await client.query(
        `INSERT INTO abbl_recipes (id, user_id, name, yield_grams, servings, notes)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, userId, recipe.name, recipe.yieldGrams, recipe.servings, recipe.notes],
      );
      await this.writeIngredients(client, userId, id, recipe.ingredients);
    });
    return { id, ...recipe };
  }

  async updateRecipe(userId: string, id: string, recipe: NewRecipe): Promise<RecipeRecord | null> {
    const existing = await this.getRecipe(userId, id);
    if (!existing) return null;
    await tx(async (client) => {
      await client.query(
        `UPDATE abbl_recipes
         SET name = $3, yield_grams = $4, servings = $5, notes = $6, updated_at = now()
         WHERE user_id = $1 AND id = $2`,
        [userId, id, recipe.name, recipe.yieldGrams, recipe.servings, recipe.notes],
      );
      await this.writeIngredients(client, userId, id, recipe.ingredients);
    });
    return { id, ...recipe };
  }

  async deleteRecipe(userId: string, id: string): Promise<boolean> {
    const result = await this.db.query("DELETE FROM abbl_recipes WHERE user_id = $1 AND id = $2", [userId, id]);
    return (result.rowCount ?? 0) > 0;
  }

  async copyRecipe(fromUserId: string, recipeId: string, toUserId: string): Promise<RecipeRecord | null> {
    const recipe = await this.getRecipe(fromUserId, recipeId);
    if (!recipe) return null;
    return this.insertRecipe(toUserId, {
      name: recipe.name,
      ingredients: recipe.ingredients,
      yieldGrams: recipe.yieldGrams,
      servings: recipe.servings,
      notes: recipe.notes,
    });
  }

  private async mealItems(userId: string, mealIds: string[]): Promise<Map<string, IngredientRow[]>> {
    const grouped = new Map<string, IngredientRow[]>();
    if (!mealIds.length) return grouped;
    const found = await rows<IngredientRow & { meal_id: string }>(
      this.db,
      `SELECT meal_id, sort_order, name, grams, kcal, protein_g, carbs_g, fat_g, fiber_g, source
       FROM abbl_meal_items
       WHERE user_id = $1 AND meal_id = ANY($2::uuid[])
       ORDER BY sort_order`,
      [userId, mealIds],
    );
    for (const row of found) {
      const list = grouped.get(row.meal_id) ?? [];
      list.push(row);
      grouped.set(row.meal_id, list);
    }
    return grouped;
  }

  async listMeals(userId: string, date: string): Promise<MealRecord[]> {
    const found = await rows<{ id: string; meal_time: string }>(
      this.db,
      "SELECT id, meal_time FROM abbl_meals WHERE user_id = $1 AND meal_date = $2::date ORDER BY meal_time, created_at",
      [userId, date],
    );
    const items = await this.mealItems(userId, found.map((row) => row.id));
    return found.map((row) => ({ id: row.id, date, time: row.meal_time, items: (items.get(row.id) ?? []).map(ingredientOf) }));
  }

  async getMeal(userId: string, id: string): Promise<MealRecord | null> {
    const found = await rows<{ id: string; meal_date: string; meal_time: string }>(
      this.db,
      "SELECT id, meal_date, meal_time FROM abbl_meals WHERE user_id = $1 AND id = $2",
      [userId, id],
    );
    if (!found[0]) return null;
    const items = await this.mealItems(userId, [id]);
    return { id, date: String(found[0].meal_date).slice(0, 10), time: found[0].meal_time, items: (items.get(id) ?? []).map(ingredientOf) };
  }

  private async writeMealItems(client: Queryable, userId: string, mealId: string, items: Ingredient[]): Promise<void> {
    await client.query("DELETE FROM abbl_meal_items WHERE user_id = $1 AND meal_id = $2", [userId, mealId]);
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      await client.query(
        `INSERT INTO abbl_meal_items (
           id, meal_id, user_id, sort_order, name, grams, kcal, protein_g, carbs_g, fat_g, fiber_g, source
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          randomUUID(),
          mealId,
          userId,
          index,
          item.name,
          item.grams,
          item.nutrients.kcal,
          item.nutrients.protein_g,
          item.nutrients.carbs_g,
          item.nutrients.fat_g,
          item.nutrients.fiber_g,
          item.source,
        ],
      );
    }
  }

  async insertMeal(userId: string, meal: NewMeal): Promise<MealRecord> {
    const id = randomUUID();
    await tx(async (client) => {
      await client.query("INSERT INTO abbl_meals (id, user_id, meal_date, meal_time) VALUES ($1,$2,$3::date,$4)", [
        id,
        userId,
        meal.date,
        meal.time,
      ]);
      await this.writeMealItems(client, userId, id, meal.items);
    });
    return { id, ...meal };
  }

  async updateMeal(userId: string, id: string, meal: NewMeal): Promise<MealRecord | null> {
    const existing = await this.getMeal(userId, id);
    if (!existing) return null;
    await tx(async (client) => {
      await client.query("UPDATE abbl_meals SET meal_date = $3::date, meal_time = $4 WHERE user_id = $1 AND id = $2", [
        userId,
        id,
        meal.date,
        meal.time,
      ]);
      await this.writeMealItems(client, userId, id, meal.items);
    });
    return { id, ...meal };
  }

  async deleteMeal(userId: string, id: string): Promise<boolean> {
    const result = await this.db.query("DELETE FROM abbl_meals WHERE user_id = $1 AND id = $2", [userId, id]);
    return (result.rowCount ?? 0) > 0;
  }

  async insertSteadyFavorite(entry: Omit<SteadyFavorite, "id">): Promise<SteadyFavorite> {
    const id = randomUUID();
    await this.db.query(
      "INSERT INTO favorites (id, name, calories, protein, carbs, fat, note) VALUES ($1,$2,$3,$4,$5,$6,NULL)",
      [id, entry.name, entry.calories, entry.protein, entry.carbs, entry.fat],
    );
    return { id, ...entry };
  }
}
