import {
  MEAL_GLUCOSE_AFTER_MS,
  MEAL_GLUCOSE_BEFORE_MS,
  blankDayGlucose,
  blankMealGlucose,
  shouldPersistMealGlucose,
  storedMealGlucose,
  summarizeDayGlucose,
  summarizeMealGlucose,
  type DayGlucose,
  type MealGlucose,
} from "../shared/mealGlucose";
import { civilDate } from "../shared/time";
import { pool } from "./db";
import { readGlucoseRange } from "./nightscout";

type MealClock = {
  id: string;
  loggedAt: Date;
  stored: unknown;
};

async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

async function saveSnapshot(id: string, summary: MealGlucose): Promise<void> {
  try {
    await pool.query(
      "UPDATE meals SET glucose_summary = $2::jsonb WHERE id = $1 AND glucose_summary IS NULL",
      [id, JSON.stringify(summary)],
    );
  } catch {
    console.warn("Meal glucose snapshot was not saved");
  }
}

/**
 * Glucose for logged meals. A closed three-hour window is stored on the meal.
 * Nightscout is read with GET only. A failed read is not stored.
 * When Nightscout is not configured, meals with no snapshot stay null so the list stays quiet.
 */
export async function glucoseForMeals(meals: MealClock[], now = Date.now()): Promise<Map<string, MealGlucose | null>> {
  const out = new Map<string, MealGlucose | null>();
  const pending: MealClock[] = [];
  for (const meal of meals) {
    const stored = storedMealGlucose(meal.stored);
    if (stored) {
      out.set(meal.id, stored);
      continue;
    }
    pending.push(meal);
  }
  if (pending.length === 0) return out;

  const groups = new Map<string, MealClock[]>();
  for (const meal of pending) {
    const key = civilDate(meal.loggedAt);
    const list = groups.get(key);
    if (list) list.push(meal);
    else groups.set(key, [meal]);
  }

  await mapPool([...groups.values()], 4, async (group) => {
    const from = Math.min(...group.map((meal) => meal.loggedAt.getTime() - MEAL_GLUCOSE_BEFORE_MS));
    const to = Math.max(...group.map((meal) => Math.min(now, meal.loggedAt.getTime() + MEAL_GLUCOSE_AFTER_MS)));
    const read = await readGlucoseRange(from, to);
    for (const meal of group) {
      const loggedAt = meal.loggedAt.getTime();
      if (!read.ok) {
        out.set(meal.id, read.reason === "not_configured" ? null : blankMealGlucose(loggedAt, now, true));
        continue;
      }
      const summary = summarizeMealGlucose({ loggedAt, now, entries: read.entries });
      if (shouldPersistMealGlucose(summary)) await saveSnapshot(meal.id, summary);
      out.set(meal.id, summary);
    }
  });
  return out;
}

export async function dayGlucose(input: {
  start: Date;
  now: Date;
  meals: { id: string; name: string; loggedAt: Date; calories: number; protein: number; carbs: number; fat: number }[];
  workouts: { id: string; name: string; startedAt: Date }[];
}): Promise<DayGlucose | null> {
  const startMs = input.start.getTime();
  const now = input.now.getTime();
  if (now < startMs) return blankDayGlucose(startMs, now);
  const read = await readGlucoseRange(startMs, now, fetch, 1500);
  const meals = input.meals.map((meal) => ({
    id: meal.id,
    name: meal.name,
    at: meal.loggedAt.getTime(),
    calories: Number(meal.calories),
    protein: Number(meal.protein),
    carbs: Number(meal.carbs),
    fat: Number(meal.fat),
  }));
  const workouts = input.workouts.map((workout) => ({
    id: workout.id,
    name: workout.name,
    at: workout.startedAt.getTime(),
  }));
  if (!read.ok) {
    if (read.reason === "not_configured") return null;
    return {
      ...blankDayGlucose(startMs, now),
      markers: summarizeDayGlucose({ startMs, now, entries: [], meals, workouts }).markers,
    };
  }
  return summarizeDayGlucose({ startMs, now, entries: read.entries, meals, workouts });
}
