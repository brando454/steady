import type { Queryable } from "../db";

export const ABBL_SQL = `
CREATE TABLE IF NOT EXISTS abbl_users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

CREATE TABLE IF NOT EXISTS abbl_allow (
  email text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS abbl_codes (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS abbl_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES abbl_users(id),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS abbl_targets (
  user_id uuid PRIMARY KEY REFERENCES abbl_users(id),
  kcal numeric NOT NULL,
  protein_g numeric NOT NULL,
  carbs_g numeric NOT NULL,
  fat_g numeric NOT NULL,
  fiber_g numeric NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS abbl_recipes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES abbl_users(id),
  name text NOT NULL,
  yield_grams numeric,
  servings numeric NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS abbl_recipe_ingredients (
  id uuid PRIMARY KEY,
  recipe_id uuid NOT NULL REFERENCES abbl_recipes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES abbl_users(id),
  sort_order integer NOT NULL,
  name text NOT NULL,
  grams numeric NOT NULL,
  kcal numeric NOT NULL,
  protein_g numeric NOT NULL,
  carbs_g numeric NOT NULL,
  fat_g numeric NOT NULL,
  fiber_g numeric,
  source text
);

CREATE TABLE IF NOT EXISTS abbl_meals (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES abbl_users(id),
  meal_date date NOT NULL,
  meal_time text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS abbl_meal_items (
  id uuid PRIMARY KEY,
  meal_id uuid NOT NULL REFERENCES abbl_meals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES abbl_users(id),
  sort_order integer NOT NULL,
  name text NOT NULL,
  grams numeric NOT NULL,
  kcal numeric NOT NULL,
  protein_g numeric NOT NULL,
  carbs_g numeric NOT NULL,
  fat_g numeric NOT NULL,
  fiber_g numeric,
  source text
);

CREATE INDEX IF NOT EXISTS abbl_codes_email_idx ON abbl_codes (email, created_at DESC);
CREATE INDEX IF NOT EXISTS abbl_tokens_user_idx ON abbl_tokens (user_id);
CREATE INDEX IF NOT EXISTS abbl_recipes_user_idx ON abbl_recipes (user_id);
CREATE INDEX IF NOT EXISTS abbl_meals_user_date_idx ON abbl_meals (user_id, meal_date);
`;

/** Invite and one-time-code rows are keyed by email because the person may not have an account yet. */
export async function migrateAbbl(client: Queryable): Promise<void> {
  await client.query(ABBL_SQL);
  const admin = process.env.ABBL_ADMIN_EMAIL?.trim().toLowerCase();
  if (!admin) return;
  await client.query("INSERT INTO abbl_allow (email) VALUES ($1) ON CONFLICT (email) DO NOTHING", [admin]);
}
