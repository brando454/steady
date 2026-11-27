import { randomUUID } from "crypto";
import { pool, rows, tx, type Queryable } from "../db";
import { INGREDIENT_UNITS, type Ingredient, type IngredientUnit, type Nutrients } from "./nutrients";
import type {
  AbblStore,
  AbblUser,
  ApiToken,
  AuthCode,
  CredentialInfo,
  InviteRecord,
  McpAudit,
  MealRecord,
  MealSource,
  NewInvite,
  NewMeal,
  NewRecipe,
  NewUser,
  OauthClient,
  OauthConnection,
  RecipeRecord,
  RefreshToken,
  SteadyFavorite,
} from "./records";

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
  quantity: number | null;
  unit: string | null;
  grams: number | null;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number | null;
  source: string | null;
  edited?: boolean | null;
  food_ref?: string | null;
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

function ingredientUnit(value: string | null): IngredientUnit | null {
  if (value == null) return null;
  return (INGREDIENT_UNITS as readonly string[]).includes(value) ? (value as IngredientUnit) : null;
}

function ingredientOf(row: IngredientRow): Ingredient {
  return {
    name: row.name,
    quantity: row.quantity == null ? null : Number(row.quantity),
    unit: ingredientUnit(row.unit),
    grams: row.grams == null ? null : Number(row.grams),
    nutrients: {
      kcal: Number(row.kcal),
      protein_g: Number(row.protein_g),
      carbs_g: Number(row.carbs_g),
      fat_g: Number(row.fat_g),
      fiber_g: row.fiber_g == null ? null : Number(row.fiber_g),
    },
    source: row.source,
    edited: row.edited === true,
    foodRef: row.food_ref ?? null,
  };
}

type MealRow = {
  id: string;
  meal_date?: string | Date;
  meal_time: string;
  meal: string | null;
  name: string | null;
  note: string | null;
  source_kind: string | null;
  source_client: string | null;
  deleted_at: Date | string | null;
};

const MEAL_COLUMNS = "id, meal_date, meal_time, meal, name, note, source_kind, source_client, deleted_at";

function civilDate(value: string | Date): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${value.getFullYear()}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

function mealSource(kind: string | null, client: string | null): MealSource {
  return { kind: kind === "ai" ? "ai" : "app", client };
}

function mealRecord(row: MealRow, date: string, items: Ingredient[]): MealRecord {
  const meal = row.meal;
  return {
    id: row.id,
    date,
    time: row.meal_time,
    meal: meal === "breakfast" || meal === "lunch" || meal === "snack" || meal === "dinner" ? meal : null,
    name: row.name,
    note: row.note,
    source: mealSource(row.source_kind, row.source_client),
    deletedAt: row.deleted_at == null ? null : iso(row.deleted_at),
    items,
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
    await this.db.query("UPDATE abbl_api_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    await this.db.query("UPDATE abbl_refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    await this.db.query("UPDATE abbl_oauth_connections SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
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
      `SELECT recipe_id, sort_order, name, quantity, unit, grams, kcal, protein_g, carbs_g, fat_g, fiber_g, source
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
           id, recipe_id, user_id, sort_order, name, quantity, unit, grams, kcal, protein_g, carbs_g, fat_g, fiber_g, source
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          randomUUID(),
          recipeId,
          userId,
          index,
          item.name,
          item.quantity,
          item.unit,
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
      `SELECT meal_id, sort_order, name, quantity, unit, grams, kcal, protein_g, carbs_g, fat_g, fiber_g, source, edited, food_ref
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
    const meals = await this.mealsWhere(userId, "user_id = $1 AND meal_date = $2::date AND deleted_at IS NULL", [userId, date]);
    return meals.map((meal) => ({ ...meal, date }));
  }

  async listMealsBetween(userId: string, start: string, end: string): Promise<MealRecord[]> {
    return this.mealsWhere(userId, "user_id = $1 AND meal_date BETWEEN $2::date AND $3::date AND deleted_at IS NULL", [userId, start, end]);
  }

  private async mealsWhere(userId: string, where: string, params: unknown[]): Promise<MealRecord[]> {
    const found = await rows<MealRow>(this.db, `SELECT ${MEAL_COLUMNS} FROM abbl_meals WHERE ${where} ORDER BY meal_time, created_at`, params);
    const items = await this.mealItems(userId, found.map((row) => row.id));
    return found.map((row) => mealRecord(row, row.meal_date == null ? "" : civilDate(row.meal_date), (items.get(row.id) ?? []).map(ingredientOf)));
  }

  async getMeal(userId: string, id: string): Promise<MealRecord | null> {
    const found = await rows<MealRow>(this.db, `SELECT ${MEAL_COLUMNS} FROM abbl_meals WHERE user_id = $1 AND id = $2`, [userId, id]);
    if (!found[0]) return null;
    const items = await this.mealItems(userId, [id]);
    return mealRecord(found[0], found[0].meal_date == null ? "" : civilDate(found[0].meal_date), (items.get(id) ?? []).map(ingredientOf));
  }

  private async writeMealItems(client: Queryable, userId: string, mealId: string, items: Ingredient[]): Promise<void> {
    await client.query("DELETE FROM abbl_meal_items WHERE user_id = $1 AND meal_id = $2", [userId, mealId]);
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      await client.query(
        `INSERT INTO abbl_meal_items (
           id, meal_id, user_id, sort_order, name, quantity, unit, grams, kcal, protein_g, carbs_g, fat_g, fiber_g, source, edited, food_ref
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          randomUUID(),
          mealId,
          userId,
          index,
          item.name,
          item.quantity,
          item.unit,
          item.grams,
          item.nutrients.kcal,
          item.nutrients.protein_g,
          item.nutrients.carbs_g,
          item.nutrients.fat_g,
          item.nutrients.fiber_g,
          item.source,
          item.edited,
          item.foodRef,
        ],
      );
    }
  }

  async insertMeal(userId: string, meal: NewMeal): Promise<MealRecord> {
    const id = randomUUID();
    await tx(async (client) => {
      await client.query(
        `INSERT INTO abbl_meals (id, user_id, meal_date, meal_time, meal, name, note, source_kind, source_client)
         VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9)`,
        [id, userId, meal.date, meal.time, meal.meal, meal.name, meal.note, meal.source.kind, meal.source.client],
      );
      await this.writeMealItems(client, userId, id, meal.items);
    });
    return { id, ...meal };
  }

  async updateMeal(userId: string, id: string, meal: NewMeal): Promise<MealRecord | null> {
    const existing = await this.getMeal(userId, id);
    if (!existing || existing.deletedAt) return null;
    await tx(async (client) => {
      await client.query(
        `UPDATE abbl_meals
         SET meal_date = $3::date, meal_time = $4, meal = $5, name = $6, note = $7, source_kind = $8, source_client = $9
         WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [userId, id, meal.date, meal.time, meal.meal, meal.name, meal.note, meal.source.kind, meal.source.client],
      );
      await this.writeMealItems(client, userId, id, meal.items);
    });
    return { id, ...meal };
  }

  async deleteMeal(userId: string, id: string, deletedAt: Date): Promise<boolean> {
    const result = await this.db.query(
      "UPDATE abbl_meals SET deleted_at = $3 WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL",
      [userId, id, deletedAt],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listDeletedMeals(userId: string): Promise<MealRecord[]> {
    const found = await rows<MealRow>(
      this.db,
      `SELECT ${MEAL_COLUMNS} FROM abbl_meals WHERE user_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
      [userId],
    );
    const items = await this.mealItems(userId, found.map((row) => row.id));
    return found.map((row) => mealRecord(row, row.meal_date == null ? "" : civilDate(row.meal_date), (items.get(row.id) ?? []).map(ingredientOf)));
  }

  async restoreMeal(userId: string, id: string): Promise<MealRecord | null> {
    const result = await this.db.query("UPDATE abbl_meals SET deleted_at = NULL WHERE user_id = $1 AND id = $2 AND deleted_at IS NOT NULL", [
      userId,
      id,
    ]);
    if ((result.rowCount ?? 0) === 0) return null;
    return this.getMeal(userId, id);
  }

  async purgeDeletedMeals(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    await this.db.query("DELETE FROM abbl_meals WHERE deleted_at IS NOT NULL AND deleted_at < $1", [cutoff]);
  }

  async saveOauthClient(client: OauthClient): Promise<void> {
    await this.db.query("INSERT INTO abbl_oauth_clients (id, name, redirect_uris, created_at) VALUES ($1,$2,$3::jsonb,$4)", [
      client.id,
      client.name,
      JSON.stringify(client.redirectUris),
      client.createdAt,
    ]);
  }

  async oauthClient(id: string): Promise<OauthClient | null> {
    const found = await rows<{ id: string; name: string; redirect_uris: string[]; created_at: Date | string }>(
      this.db,
      "SELECT id, name, redirect_uris, created_at FROM abbl_oauth_clients WHERE id = $1",
      [id],
    );
    if (!found[0]) return null;
    return { id: found[0].id, name: found[0].name, redirectUris: found[0].redirect_uris, createdAt: iso(found[0].created_at) };
  }

  async saveAuthCode(code: AuthCode): Promise<void> {
    await this.db.query(
      "INSERT INTO abbl_oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [code.codeHash, code.clientId, code.userId, code.redirectUri, code.codeChallenge, code.expiresAt],
    );
  }

  async peekAuthCode(codeHash: string, now: Date): Promise<AuthCode | null> {
    const found = await rows<{
      code_hash: string;
      client_id: string;
      user_id: string;
      redirect_uri: string;
      code_challenge: string;
      expires_at: Date | string;
    }>(
      this.db,
      `SELECT code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at
       FROM abbl_oauth_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2`,
      [codeHash, now],
    );
    if (!found[0]) return null;
    return {
      codeHash: found[0].code_hash,
      clientId: found[0].client_id,
      userId: found[0].user_id,
      redirectUri: found[0].redirect_uri,
      codeChallenge: found[0].code_challenge,
      expiresAt: iso(found[0].expires_at),
    };
  }

  async takeAuthCode(codeHash: string, now: Date): Promise<AuthCode | null> {
    const found = await rows<{
      code_hash: string;
      client_id: string;
      user_id: string;
      redirect_uri: string;
      code_challenge: string;
      expires_at: Date | string;
    }>(
      this.db,
      `UPDATE abbl_oauth_codes SET used_at = $2
       WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2
       RETURNING code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at`,
      [codeHash, now],
    );
    if (!found[0]) return null;
    return {
      codeHash: found[0].code_hash,
      clientId: found[0].client_id,
      userId: found[0].user_id,
      redirectUri: found[0].redirect_uri,
      codeChallenge: found[0].code_challenge,
      expiresAt: iso(found[0].expires_at),
    };
  }

  async saveConnection(connection: OauthConnection): Promise<void> {
    await this.db.query("INSERT INTO abbl_oauth_connections (id, user_id, client_id, name, created_at) VALUES ($1,$2,$3,$4,$5)", [
      connection.id,
      connection.userId,
      connection.clientId,
      connection.name,
      connection.createdAt,
    ]);
  }

  async saveApiToken(token: ApiToken): Promise<void> {
    await this.db.query(
      `INSERT INTO abbl_api_tokens
         (id, user_id, token_hash, kind, name, client_id, connection_id, expires_at, last_used_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        token.id,
        token.userId,
        token.tokenHash,
        token.kind,
        token.name,
        token.clientId,
        token.connectionId,
        token.expiresAt,
        token.lastUsedAt,
        token.createdAt,
      ],
    );
  }

  async apiTokenForHash(tokenHash: string, now: Date): Promise<ApiToken | null> {
    const found = await rows<{
      id: string;
      user_id: string;
      token_hash: string;
      kind: "pat" | "oauth";
      name: string;
      client_id: string | null;
      connection_id: string | null;
      expires_at: Date | string | null;
      last_used_at: Date | string | null;
      created_at: Date | string;
      revoked_at: Date | string | null;
    }>(
      this.db,
      `UPDATE abbl_api_tokens AS token
       SET last_used_at = $2
       WHERE token.token_hash = $1
         AND token.revoked_at IS NULL
         AND (token.expires_at IS NULL OR token.expires_at > $2)
         AND EXISTS (SELECT 1 FROM abbl_users WHERE id = token.user_id AND disabled_at IS NULL)
         AND (token.connection_id IS NULL OR EXISTS (
           SELECT 1 FROM abbl_oauth_connections WHERE id = token.connection_id AND revoked_at IS NULL
         ))
       RETURNING id, user_id, token_hash, kind, name, client_id, connection_id, expires_at, last_used_at, created_at, revoked_at`,
      [tokenHash, now],
    );
    const row = found[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      kind: row.kind,
      name: row.name,
      clientId: row.client_id,
      connectionId: row.connection_id,
      expiresAt: row.expires_at == null ? null : iso(row.expires_at),
      lastUsedAt: row.last_used_at == null ? null : iso(row.last_used_at),
      createdAt: iso(row.created_at),
      revokedAt: null,
    };
  }

  async saveRefreshToken(token: RefreshToken): Promise<void> {
    await this.db.query(
      "INSERT INTO abbl_refresh_tokens (token_hash, user_id, client_id, connection_id, expires_at) VALUES ($1,$2,$3,$4,$5)",
      [token.tokenHash, token.userId, token.clientId, token.connectionId, token.expiresAt],
    );
  }

  async takeRefreshToken(tokenHash: string, now: Date): Promise<RefreshToken | null> {
    const found = await rows<{ token_hash: string; user_id: string; client_id: string; connection_id: string; expires_at: Date | string }>(
      this.db,
      `UPDATE abbl_refresh_tokens SET revoked_at = $2
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2
       RETURNING token_hash, user_id, client_id, connection_id, expires_at`,
      [tokenHash, now],
    );
    if (!found[0]) return null;
    return {
      tokenHash: found[0].token_hash,
      userId: found[0].user_id,
      clientId: found[0].client_id,
      connectionId: found[0].connection_id,
      expiresAt: iso(found[0].expires_at),
    };
  }

  async revokeAccessForConnection(userId: string, connectionId: string): Promise<void> {
    await this.db.query("UPDATE abbl_api_tokens SET revoked_at = now() WHERE user_id = $1 AND connection_id = $2 AND revoked_at IS NULL", [
      userId,
      connectionId,
    ]);
  }

  async listCredentials(userId: string): Promise<{ tokens: CredentialInfo[]; connections: CredentialInfo[] }> {
    const tokens = await rows<{ id: string; name: string; created_at: Date | string; last_used_at: Date | string | null }>(
      this.db,
      `SELECT id, name, created_at, last_used_at FROM abbl_api_tokens
       WHERE user_id = $1 AND kind = 'pat' AND revoked_at IS NULL ORDER BY created_at`,
      [userId],
    );
    const connections = await rows<{ id: string; name: string; created_at: Date | string; last_used_at: Date | string | null }>(
      this.db,
      `SELECT connection.id, connection.name, connection.created_at,
              (SELECT max(last_used_at) FROM abbl_api_tokens WHERE connection_id = connection.id) AS last_used_at
       FROM abbl_oauth_connections connection
       WHERE connection.user_id = $1 AND connection.revoked_at IS NULL
       ORDER BY connection.created_at`,
      [userId],
    );
    return {
      tokens: tokens.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: iso(row.created_at),
        lastUsedAt: row.last_used_at == null ? null : iso(row.last_used_at),
      })),
      connections: connections.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: iso(row.created_at),
        lastUsedAt: row.last_used_at == null ? null : iso(row.last_used_at),
      })),
    };
  }

  async revokeCredential(userId: string, id: string): Promise<boolean> {
    const token = await this.db.query(
      "UPDATE abbl_api_tokens SET revoked_at = now() WHERE user_id = $1 AND id = $2 AND kind = 'pat' AND revoked_at IS NULL",
      [userId, id],
    );
    if ((token.rowCount ?? 0) > 0) return true;
    const connection = await this.db.query(
      "UPDATE abbl_oauth_connections SET revoked_at = now() WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL",
      [userId, id],
    );
    if ((connection.rowCount ?? 0) === 0) return false;
    await this.revokeAccessForConnection(userId, id);
    await this.db.query("UPDATE abbl_refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND connection_id = $2 AND revoked_at IS NULL", [
      userId,
      id,
    ]);
    return true;
  }

  async insertAudit(event: Omit<McpAudit, "id" | "createdAt">, createdAt: Date): Promise<void> {
    await this.db.query(
      "INSERT INTO abbl_mcp_audit (id, user_id, action, meal_id, client_name, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [randomUUID(), event.userId, event.action, event.mealId, event.clientName, createdAt],
    );
  }

  async listAudits(userId: string): Promise<McpAudit[]> {
    const found = await rows<{ id: string; user_id: string; action: McpAudit["action"]; meal_id: string | null; client_name: string | null; created_at: Date | string }>(
      this.db,
      "SELECT id, user_id, action, meal_id, client_name, created_at FROM abbl_mcp_audit WHERE user_id = $1 ORDER BY created_at",
      [userId],
    );
    return found.map((row) => ({
      id: row.id,
      userId: row.user_id,
      action: row.action,
      mealId: row.meal_id,
      clientName: row.client_name,
      createdAt: iso(row.created_at),
    }));
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
