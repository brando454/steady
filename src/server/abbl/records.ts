import type { Ingredient, Nutrients } from "./nutrients";

export type AbblUser = {
  id: string;
  email: string;
  disabled: boolean;
};

export type Invite = {
  email: string;
  status: "invited" | "joined" | "disabled";
  userId: string | null;
};

export type RecipeRecord = {
  id: string;
  name: string;
  ingredients: Ingredient[];
  yieldGrams: number | null;
  servings: number;
  notes: string | null;
};

export type MealRecord = {
  id: string;
  date: string;
  time: string;
  items: Ingredient[];
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
  isAllowed(email: string): Promise<boolean>;
  allow(email: string): Promise<void>;
  unallow(email: string): Promise<boolean>;
  listInvites(): Promise<Invite[]>;
  saveCode(email: string, codeHash: string, expiresAt: Date): Promise<void>;
  consumeCode(email: string, codeHash: string, now: Date): Promise<boolean>;
  userByEmail(email: string): Promise<AbblUser | null>;
  userById(id: string): Promise<AbblUser | null>;
  createUser(email: string): Promise<AbblUser>;
  disableUser(id: string): Promise<boolean>;
  enableUser(email: string): Promise<void>;
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
  getMeal(userId: string, id: string): Promise<MealRecord | null>;
  insertMeal(userId: string, meal: NewMeal): Promise<MealRecord>;
  updateMeal(userId: string, id: string, meal: NewMeal): Promise<MealRecord | null>;
  deleteMeal(userId: string, id: string): Promise<boolean>;
  insertSteadyFavorite(entry: Omit<SteadyFavorite, "id">): Promise<SteadyFavorite>;
};
