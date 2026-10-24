import pg from "pg";
import { connectionConfig } from "./pg-config";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

pg.types.setTypeParser(1700, (value) => (value == null ? null : Number(value)));
pg.types.setTypeParser(1082, (value) => value);

export const pool = new pg.Pool({
  ...connectionConfig(databaseUrl),
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

export type Queryable = pg.Pool | pg.PoolClient;

export async function rows<T>(client: Queryable, text: string, params: unknown[] = []): Promise<T[]> {
  const result = await client.query(text, params);
  return result.rows as T[];
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* The connection may already be dead. */
    }
    throw error;
  } finally {
    client.release();
  }
}
