import type { Ingredient, MealType, Nutrients } from "./nutrients";

export type AbblUser = {
  id: string;
  name: string;
  email: string | null;
  admin: boolean;
  disabled: boolean;
};

export type InviteStatus = "pending" | "used" | "revoked" | "expired";

export type InviteRecord = {
  id: string;
  codeHash: string;
  name: string;
  email: string | null;
  userId: string | null;
  createdBy: string | null;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type NewInvite = {
  codeHash: string;
  name: string;
  email: string | null;
  userId: string | null;
  createdBy: string;
  expiresAt: Date;
};

export type NewUser = {
  name: string;
  email: string | null;
  admin: boolean;
};

export type RecipeRecord = {
  id: string;
  name: string;
  ingredients: Ingredient[];
  yieldGrams: number | null;
  servings: number;
  notes: string | null;
};

export type MealSource = {
  kind: "app" | "ai";
  client: string | null;
};

export type MealRecord = {
  id: string;
  date: string;
  time: string;
  meal: MealType | null;
  name: string | null;
  note: string | null;
  source: MealSource;
  deletedAt: string | null;
  items: Ingredient[];
};

export type OauthClient = {
  id: string;
  name: string;
  redirectUris: string[];
  createdAt: string;
};

export type AuthCode = {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: string;
};

export type OauthConnection = {
  id: string;
  userId: string;
  clientId: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
};

export type ApiToken = {
  id: string;
  userId: string;
  tokenHash: string;
  kind: "pat" | "oauth";
  name: string;
  clientId: string | null;
  connectionId: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
};

export type RefreshToken = {
  tokenHash: string;
  userId: string;
  clientId: string;
  connectionId: string;
  expiresAt: string;
};

export type CredentialInfo = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type McpAudit = {
  id: string;
  userId: string;
  action: "log_meal" | "edit_meal" | "delete_meal";
  mealId: string | null;
  clientName: string | null;
  createdAt: string;
};

export type NewRecipe = Omit<RecipeRecord, "id">;
export type NewMeal = Omit<MealRecord, "id">;

export type SteadyFavorite = {
  id: string;
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

export type AbblStore = {
  findAdmin(): Promise<AbblUser | null>;
  userById(id: string): Promise<AbblUser | null>;
  createUser(input: NewUser): Promise<AbblUser>;
  updateName(id: string, name: string): Promise<AbblUser | null>;
  listUsers(): Promise<AbblUser[]>;
  disableUser(id: string): Promise<boolean>;
  enableUser(id: string): Promise<void>;
  insertInvite(invite: NewInvite): Promise<InviteRecord>;
  listInvites(): Promise<InviteRecord[]>;
  revokeInvite(id: string): Promise<boolean>;
  consumeInvite(codeHash: string, now: Date): Promise<InviteRecord | null>;
  linkInviteUser(inviteId: string, userId: string): Promise<void>;
  saveToken(userId: string, tokenHash: string): Promise<void>;
  userForToken(tokenHash: string): Promise<AbblUser | null>;
  revokeToken(tokenHash: string): Promise<void>;
  revokeUserTokens(userId: string): Promise<void>;
  getTargets(userId: string): Promise<Nutrients | null>;
  putTargets(userId: string, targets: Nutrients): Promise<Nutrients>;
  listRecipes(userId: string): Promise<RecipeRecord[]>;
  getRecipe(userId: string, id: string): Promise<RecipeRecord | null>;
  insertRecipe(userId: string, recipe: NewRecipe): Promise<RecipeRecord>;
  updateRecipe(userId: string, id: string, recipe: NewRecipe): Promise<RecipeRecord | null>;
  deleteRecipe(userId: string, id: string): Promise<boolean>;
  copyRecipe(fromUserId: string, recipeId: string, toUserId: string): Promise<RecipeRecord | null>;
  listMeals(userId: string, date: string): Promise<MealRecord[]>;
  listMealsBetween(userId: string, start: string, end: string): Promise<MealRecord[]>;
  getMeal(userId: string, id: string): Promise<MealRecord | null>;
  insertMeal(userId: string, meal: NewMeal): Promise<MealRecord>;
  updateMeal(userId: string, id: string, meal: NewMeal): Promise<MealRecord | null>;
  deleteMeal(userId: string, id: string, deletedAt: Date): Promise<boolean>;
  listDeletedMeals(userId: string): Promise<MealRecord[]>;
  restoreMeal(userId: string, id: string): Promise<MealRecord | null>;
  purgeDeletedMeals(now: Date): Promise<void>;
  saveOauthClient(client: OauthClient): Promise<void>;
  oauthClient(id: string): Promise<OauthClient | null>;
  saveAuthCode(code: AuthCode): Promise<void>;
  peekAuthCode(codeHash: string, now: Date): Promise<AuthCode | null>;
  takeAuthCode(codeHash: string, now: Date): Promise<AuthCode | null>;
  saveConnection(connection: OauthConnection): Promise<void>;
  saveApiToken(token: ApiToken): Promise<void>;
  apiTokenForHash(tokenHash: string, now: Date): Promise<ApiToken | null>;
  saveRefreshToken(token: RefreshToken): Promise<void>;
  takeRefreshToken(tokenHash: string, now: Date): Promise<RefreshToken | null>;
  revokeAccessForConnection(userId: string, connectionId: string): Promise<void>;
  listCredentials(userId: string): Promise<{ tokens: CredentialInfo[]; connections: CredentialInfo[] }>;
  revokeCredential(userId: string, id: string): Promise<boolean>;
  insertAudit(event: Omit<McpAudit, "id" | "createdAt">, createdAt: Date): Promise<void>;
  listAudits(userId: string): Promise<McpAudit[]>;
  insertSteadyFavorite(entry: Omit<SteadyFavorite, "id">): Promise<SteadyFavorite>;
};
