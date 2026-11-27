import { randomUUID } from "crypto";
import type { Nutrients } from "./nutrients";
import type {
  AbblStore,
  AbblUser,
  ApiToken,
  AuthCode,
  CredentialInfo,
  InviteRecord,
  McpAudit,
  MealRecord,
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

type TokenRow = { userId: string; tokenHash: string; revoked: boolean };

export class MemoryAbblStore implements AbblStore {
  users = new Map<string, AbblUser>();
  invites: InviteRecord[] = [];
  tokens: TokenRow[] = [];
  targets = new Map<string, Nutrients>();
  recipes = new Map<string, { userId: string; recipe: RecipeRecord }>();
  meals = new Map<string, { userId: string; meal: MealRecord }>();
  favorites: SteadyFavorite[] = [];
  oauthClients = new Map<string, OauthClient>();
  authCodes = new Map<string, AuthCode & { used: boolean }>();
  connections = new Map<string, OauthConnection>();
  apiTokens: ApiToken[] = [];
  refreshTokens: Array<RefreshToken & { revoked: boolean }> = [];
  audits: McpAudit[] = [];

  async findAdmin(): Promise<AbblUser | null> {
    return [...this.users.values()].find((user) => user.admin) ?? null;
  }

  async userById(id: string): Promise<AbblUser | null> {
    return this.users.get(id) ?? null;
  }

  async createUser(input: NewUser): Promise<AbblUser> {
    if (input.admin && (await this.findAdmin())) throw new Error("admin exists");
    const user = { id: randomUUID(), name: input.name, email: input.email, admin: input.admin, disabled: false };
    this.users.set(user.id, user);
    return user;
  }

  async updateName(id: string, name: string): Promise<AbblUser | null> {
    const user = this.users.get(id);
    if (!user) return null;
    user.name = name;
    return user;
  }

  async listUsers(): Promise<AbblUser[]> {
    return [...this.users.values()];
  }

  async disableUser(id: string): Promise<boolean> {
    const user = this.users.get(id);
    if (!user) return false;
    user.disabled = true;
    await this.revokeUserTokens(id);
    return true;
  }

  async enableUser(id: string): Promise<void> {
    const user = this.users.get(id);
    if (user) user.disabled = false;
  }

  async insertInvite(invite: NewInvite): Promise<InviteRecord> {
    const now = new Date().toISOString();
    const row: InviteRecord = {
      id: randomUUID(),
      codeHash: invite.codeHash,
      name: invite.name,
      email: invite.email,
      userId: invite.userId,
      createdBy: invite.createdBy,
      expiresAt: invite.expiresAt.toISOString(),
      usedAt: null,
      revokedAt: null,
      createdAt: now,
    };
    this.invites.push(row);
    return row;
  }

  async listInvites(): Promise<InviteRecord[]> {
    return [...this.invites];
  }

  async revokeInvite(id: string): Promise<boolean> {
    const row = this.invites.find((item) => item.id === id);
    if (!row || row.usedAt) return false;
    row.revokedAt = row.revokedAt ?? new Date().toISOString();
    return true;
  }

  async consumeInvite(codeHash: string, now: Date): Promise<InviteRecord | null> {
    const row = this.invites.find((item) => item.codeHash === codeHash && !item.usedAt && !item.revokedAt && Date.parse(item.expiresAt) > now.getTime());
    if (!row) return null;
    row.usedAt = now.toISOString();
    return row;
  }

  async linkInviteUser(inviteId: string, userId: string): Promise<void> {
    const row = this.invites.find((item) => item.id === inviteId);
    if (row && !row.userId) row.userId = userId;
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
    const now = new Date().toISOString();
    for (const token of this.apiTokens) {
      if (token.userId === userId && !token.revokedAt) token.revokedAt = now;
    }
    for (const token of this.refreshTokens) {
      if (token.userId === userId) token.revoked = true;
    }
    for (const connection of this.connections.values()) {
      if (connection.userId === userId && !connection.revokedAt) connection.revokedAt = now;
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
    return [...this.meals.values()]
      .filter((row) => row.userId === userId && row.meal.date === date && !row.meal.deletedAt)
      .map((row) => row.meal);
  }

  async listMealsBetween(userId: string, start: string, end: string): Promise<MealRecord[]> {
    return [...this.meals.values()]
      .filter((row) => row.userId === userId && !row.meal.deletedAt && row.meal.date >= start && row.meal.date <= end)
      .map((row) => row.meal);
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
    if (!existing || existing.deletedAt) return null;
    const saved = { id, ...meal, deletedAt: null };
    this.meals.set(id, { userId, meal: saved });
    return saved;
  }

  async deleteMeal(userId: string, id: string, deletedAt: Date): Promise<boolean> {
    const existing = await this.getMeal(userId, id);
    if (!existing || existing.deletedAt) return false;
    existing.deletedAt = deletedAt.toISOString();
    return true;
  }

  async listDeletedMeals(userId: string): Promise<MealRecord[]> {
    return [...this.meals.values()]
      .filter((row) => row.userId === userId && row.meal.deletedAt)
      .map((row) => row.meal)
      .sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""));
  }

  async restoreMeal(userId: string, id: string): Promise<MealRecord | null> {
    const existing = await this.getMeal(userId, id);
    if (!existing?.deletedAt) return null;
    existing.deletedAt = null;
    return existing;
  }

  async purgeDeletedMeals(now: Date): Promise<void> {
    const cutoff = now.getTime() - 30 * 24 * 60 * 60 * 1000;
    for (const [id, row] of this.meals) {
      if (row.meal.deletedAt && Date.parse(row.meal.deletedAt) < cutoff) this.meals.delete(id);
    }
  }

  async saveOauthClient(client: OauthClient): Promise<void> {
    this.oauthClients.set(client.id, client);
  }

  async oauthClient(id: string): Promise<OauthClient | null> {
    return this.oauthClients.get(id) ?? null;
  }

  async saveAuthCode(code: AuthCode): Promise<void> {
    this.authCodes.set(code.codeHash, { ...code, used: false });
  }

  async peekAuthCode(codeHash: string, now: Date): Promise<AuthCode | null> {
    const code = this.authCodes.get(codeHash);
    if (!code || code.used || Date.parse(code.expiresAt) <= now.getTime()) return null;
    return code;
  }

  async takeAuthCode(codeHash: string, now: Date): Promise<AuthCode | null> {
    const code = await this.peekAuthCode(codeHash, now);
    if (!code) return null;
    const row = this.authCodes.get(codeHash);
    if (row) row.used = true;
    return code;
  }

  async saveConnection(connection: OauthConnection): Promise<void> {
    this.connections.set(connection.id, connection);
  }

  async saveApiToken(token: ApiToken): Promise<void> {
    this.apiTokens.push(token);
  }

  async apiTokenForHash(tokenHash: string, now: Date): Promise<ApiToken | null> {
    const token = this.apiTokens.find((item) => item.tokenHash === tokenHash && !item.revokedAt);
    if (!token) return null;
    if (token.expiresAt && Date.parse(token.expiresAt) <= now.getTime()) return null;
    const user = this.users.get(token.userId);
    if (!user || user.disabled) return null;
    if (token.connectionId) {
      const connection = this.connections.get(token.connectionId);
      if (!connection || connection.revokedAt) return null;
    }
    token.lastUsedAt = now.toISOString();
    return token;
  }

  async saveRefreshToken(token: RefreshToken): Promise<void> {
    this.refreshTokens.push({ ...token, revoked: false });
  }

  async takeRefreshToken(tokenHash: string, now: Date): Promise<RefreshToken | null> {
    const token = this.refreshTokens.find((item) => item.tokenHash === tokenHash && !item.revoked);
    if (!token || Date.parse(token.expiresAt) <= now.getTime()) return null;
    token.revoked = true;
    return token;
  }

  async revokeAccessForConnection(userId: string, connectionId: string): Promise<void> {
    const now = new Date().toISOString();
    for (const token of this.apiTokens) {
      if (token.userId === userId && token.connectionId === connectionId && !token.revokedAt) token.revokedAt = now;
    }
  }

  async listCredentials(userId: string): Promise<{ tokens: CredentialInfo[]; connections: CredentialInfo[] }> {
    const tokens = this.apiTokens
      .filter((token) => token.userId === userId && token.kind === "pat" && !token.revokedAt)
      .map((token) => ({ id: token.id, name: token.name, createdAt: token.createdAt, lastUsedAt: token.lastUsedAt }));
    const connections = [...this.connections.values()]
      .filter((connection) => connection.userId === userId && !connection.revokedAt)
      .map((connection) => {
        const used = this.apiTokens
          .filter((token) => token.connectionId === connection.id && token.lastUsedAt)
          .map((token) => token.lastUsedAt as string)
          .sort();
        return { id: connection.id, name: connection.name, createdAt: connection.createdAt, lastUsedAt: used.at(-1) ?? null };
      });
    return { tokens, connections };
  }

  async revokeCredential(userId: string, id: string): Promise<boolean> {
    const token = this.apiTokens.find((item) => item.id === id && item.userId === userId && item.kind === "pat" && !item.revokedAt);
    if (token) {
      token.revokedAt = new Date().toISOString();
      return true;
    }
    const connection = this.connections.get(id);
    if (!connection || connection.userId !== userId || connection.revokedAt) return false;
    connection.revokedAt = new Date().toISOString();
    await this.revokeAccessForConnection(userId, id);
    for (const refresh of this.refreshTokens) {
      if (refresh.userId === userId && refresh.connectionId === id) refresh.revoked = true;
    }
    return true;
  }

  async insertAudit(event: Omit<McpAudit, "id" | "createdAt">, createdAt: Date): Promise<void> {
    this.audits.push({ ...event, id: randomUUID(), createdAt: createdAt.toISOString() });
  }

  async listAudits(userId: string): Promise<McpAudit[]> {
    return this.audits.filter((event) => event.userId === userId);
  }

  async insertSteadyFavorite(entry: Omit<SteadyFavorite, "id">): Promise<SteadyFavorite> {
    const saved = { id: randomUUID(), ...entry };
    this.favorites.push(saved);
    return saved;
  }
}
