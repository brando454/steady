import type { Queryable } from "../db";

export const ABBL_SQL = `
CREATE TABLE IF NOT EXISTS abbl_users (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text,
  admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

CREATE TABLE IF NOT EXISTS abbl_invites (
  id uuid PRIMARY KEY,
  code_hash text NOT NULL UNIQUE,
  name text NOT NULL,
  email text,
  user_id uuid REFERENCES abbl_users(id),
  created_by uuid REFERENCES abbl_users(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
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
  quantity numeric,
  unit text,
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
  meal text,
  name text,
  note text,
  source_kind text,
  source_client text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS abbl_meal_items (
  id uuid PRIMARY KEY,
  meal_id uuid NOT NULL REFERENCES abbl_meals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES abbl_users(id),
  sort_order integer NOT NULL,
  name text NOT NULL,
  quantity numeric,
  unit text,
  grams numeric,
  kcal numeric NOT NULL,
  protein_g numeric NOT NULL,
  carbs_g numeric NOT NULL,
  fat_g numeric NOT NULL,
  fiber_g numeric,
  source text,
  edited boolean NOT NULL DEFAULT false,
  food_ref text
);

ALTER TABLE abbl_recipe_ingredients ADD COLUMN IF NOT EXISTS quantity numeric;
ALTER TABLE abbl_recipe_ingredients ADD COLUMN IF NOT EXISTS unit text;
ALTER TABLE abbl_meal_items ADD COLUMN IF NOT EXISTS quantity numeric;
ALTER TABLE abbl_meal_items ADD COLUMN IF NOT EXISTS unit text;
ALTER TABLE abbl_meals ADD COLUMN IF NOT EXISTS meal text;
ALTER TABLE abbl_meals ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE abbl_meals ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE abbl_meals ADD COLUMN IF NOT EXISTS source_kind text;
ALTER TABLE abbl_meals ADD COLUMN IF NOT EXISTS source_client text;
ALTER TABLE abbl_meals ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE abbl_meal_items ADD COLUMN IF NOT EXISTS edited boolean NOT NULL DEFAULT false;
ALTER TABLE abbl_meal_items ADD COLUMN IF NOT EXISTS food_ref text;
ALTER TABLE abbl_meal_items ALTER COLUMN grams DROP NOT NULL;

CREATE TABLE IF NOT EXISTS abbl_oauth_clients (
  id text PRIMARY KEY,
  name text NOT NULL,
  redirect_uris jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS abbl_oauth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES abbl_oauth_clients(id),
  user_id uuid NOT NULL REFERENCES abbl_users(id),
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE IF NOT EXISTS abbl_oauth_connections (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES abbl_users(id),
  client_id text NOT NULL REFERENCES abbl_oauth_clients(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS abbl_api_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES abbl_users(id),
  token_hash text NOT NULL UNIQUE,
  kind text NOT NULL,
  name text NOT NULL,
  client_id text,
  connection_id uuid,
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS abbl_refresh_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES abbl_users(id),
  client_id text NOT NULL,
  connection_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS abbl_mcp_audit (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES abbl_users(id),
  action text NOT NULL,
  meal_id uuid,
  client_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS abbl_invites_user_idx ON abbl_invites (user_id);
CREATE INDEX IF NOT EXISTS abbl_tokens_user_idx ON abbl_tokens (user_id);
CREATE INDEX IF NOT EXISTS abbl_recipes_user_idx ON abbl_recipes (user_id);
CREATE INDEX IF NOT EXISTS abbl_meals_user_date_idx ON abbl_meals (user_id, meal_date);
`;

/** The first draft of this branch used email codes. Fold that shape into invite codes if it is already present. */
const ABBL_AUTH_REPAIR = `
DROP TABLE IF EXISTS abbl_codes;
DROP TABLE IF EXISTS abbl_allow;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'abbl_users' AND column_name = 'email'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'abbl_users' AND column_name = 'name'
  ) THEN
    ALTER TABLE abbl_users ADD COLUMN name text;
    ALTER TABLE abbl_users ADD COLUMN admin boolean NOT NULL DEFAULT false;
    UPDATE abbl_users SET name = split_part(email, '@', 1) WHERE name IS NULL;
    ALTER TABLE abbl_users ALTER COLUMN name SET NOT NULL;
    ALTER TABLE abbl_users ALTER COLUMN email DROP NOT NULL;
    ALTER TABLE abbl_users DROP CONSTRAINT IF EXISTS abbl_users_email_key;
  END IF;
END $$;
`;

export async function migrateAbbl(client: Queryable): Promise<void> {
  await client.query(ABBL_SQL);
  await client.query(ABBL_AUTH_REPAIR);
  await client.query("CREATE UNIQUE INDEX IF NOT EXISTS abbl_one_admin_idx ON abbl_users ((true)) WHERE admin");
}
