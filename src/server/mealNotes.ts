import { pool, rows } from "./db";
import { deleteNightscoutNote, deliverNightscoutNote } from "./nightscoutWrite";

type NoteMeal = {
  id: string;
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  logged_at: Date;
  nightscout_id: string | null;
  nightscout_pending: boolean;
};

const inflight = new Map<string, Promise<void>>();

function queue(id: string, job: () => Promise<void>): Promise<void> {
  const prev = inflight.get(id) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(job)
    .finally(() => {
      if (inflight.get(id) === next) inflight.delete(id);
    });
  inflight.set(id, next);
  return next;
}

async function loadMeal(id: string): Promise<NoteMeal | null> {
  const found = await rows<NoteMeal>(
    pool,
    `SELECT id, name, calories, protein, carbs, fat, logged_at, nightscout_id, nightscout_pending
     FROM meals WHERE id = $1`,
    [id],
  );
  return found[0] ?? null;
}

async function writeOnce(id: string): Promise<void> {
  const meal = await loadMeal(id);
  if (!meal || !meal.nightscout_pending) return;
  const loggedAt = meal.logged_at instanceof Date ? meal.logged_at : new Date(meal.logged_at);
  const createdAt = loggedAt.toISOString();
  const delivered = await deliverNightscoutNote({
    meal: {
      name: meal.name,
      calories: Number(meal.calories),
      protein: Number(meal.protein),
      carbs: Number(meal.carbs),
      fat: Number(meal.fat),
      createdAt,
    },
    existingId: meal.nightscout_id,
  });
  if (!delivered.ok) {
    if (delivered.reason !== "not_configured") console.warn(`Nightscout note was not saved (${delivered.reason})`);
    return;
  }
  const saved = await pool.query(
    "UPDATE meals SET nightscout_id = COALESCE(nightscout_id, $2) WHERE id = $1",
    [id, delivered.id],
  );
  if (saved.rowCount === 0) {
    await deleteNightscoutNote({ id: delivered.id });
    return;
  }
  await pool.query(
    `UPDATE meals
     SET nightscout_pending = false
     WHERE id = $1
       AND logged_at = $2
       AND name = $3
       AND calories = $4
       AND protein = $5
       AND carbs = $6
       AND fat = $7`,
    [id, loggedAt, meal.name, meal.calories, meal.protein, meal.carbs, meal.fat],
  );
}

/** Post or update the Note for one meal. A failure leaves the meal pending and does not throw. */
export function syncMealNote(id: string): Promise<void> {
  return queue(id, () => writeOnce(id)).catch((error: unknown) => {
    console.warn(error instanceof Error ? `Nightscout note was not saved (${error.name})` : "Nightscout note was not saved");
  });
}

/** Delete the Note for a meal that is already gone. A failure is queued and does not throw. */
export async function removeMealNote(nightscoutId: string | null): Promise<void> {
  if (!nightscoutId) return;
  try {
    const result = await deleteNightscoutNote({ id: nightscoutId });
    if (result.ok) {
      await pool.query("DELETE FROM nightscout_deletes WHERE nightscout_id = $1", [nightscoutId]);
      return;
    }
    if (result.reason === "not_configured") {
      await pool.query(
        `INSERT INTO nightscout_deletes (nightscout_id) VALUES ($1)
         ON CONFLICT (nightscout_id) DO NOTHING`,
        [nightscoutId],
      );
      return;
    }
    console.warn(`Nightscout note was not deleted (${result.reason})`);
    await pool.query(
      `INSERT INTO nightscout_deletes (nightscout_id) VALUES ($1)
       ON CONFLICT (nightscout_id) DO NOTHING`,
      [nightscoutId],
    );
  } catch {
    console.warn("Nightscout note was not deleted");
  }
}

let retrying: Promise<void> | null = null;

/** Quietly finish Notes that did not reach Nightscout the first time. */
export function retryNightscoutNotes(): Promise<void> {
  if (retrying) return retrying;
  retrying = runRetry().finally(() => {
    retrying = null;
  });
  return retrying;
}

async function runRetry(): Promise<void> {
  try {
    const pending = await rows<{ id: string }>(
      pool,
      "SELECT id FROM meals WHERE nightscout_pending = true ORDER BY logged_at DESC LIMIT 8",
    );
    for (const meal of pending) await syncMealNote(meal.id);
    const doomed = await rows<{ nightscout_id: string }>(
      pool,
      "SELECT nightscout_id FROM nightscout_deletes ORDER BY queued_at LIMIT 8",
    );
    for (const row of doomed) await removeMealNote(row.nightscout_id);
  } catch {
    console.warn("Nightscout note retry did not finish");
  }
}
