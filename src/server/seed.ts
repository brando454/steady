import { randomUUID } from "crypto";
import { pool, rows, tx } from "./db";
import { detectPr } from "../shared/logic";
import {
  DAYS,
  DEFAULT_SETTINGS,
  EXERCISES,
  SAMPLE_PLAN,
  SUBSTITUTES,
  workingWeight,
} from "../shared/program";
import { addDays, civilDate, wallTimeToUtc, weekStartCivil } from "../shared/time";
import type { Perf } from "../shared/logic";

const FAVORITES: Array<[string, number, number, number, number, string | null]> = [
  ["Eggs, oats, and berries", 680, 38, 72, 24, "3 eggs, 80 g oats, berries, splash of milk"],
  ["Protein shake and banana", 320, 42, 28, 6, "Fairlife and a scoop"],
  ["Chicken rice bowl", 740, 58, 70, 22, "About 200 g chicken, rice, salsa"],
  ["Greek yogurt and granola", 420, 32, 48, 12, null],
  ["Turkey sandwich", 560, 40, 52, 18, null],
  ["Salmon, potatoes, and greens", 690, 48, 45, 32, null],
  ["Cottage cheese and fruit", 280, 32, 22, 6, null],
  ["Beef burrito bowl", 780, 52, 68, 30, null],
  ["Overnight oats", 510, 30, 70, 14, null],
  ["Fairlife and cereal", 340, 22, 48, 6, null],
  ["Tuna rice cakes", 390, 36, 38, 8, null],
  ["Steak and rice", 820, 62, 60, 32, null],
];

const WEIGHT_BY_AGE: Record<number, number> = {
  0: 214.9,
  1: 215.3,
  2: 215.1,
  3: 214.8,
  4: 215.4,
  5: 215.0,
  6: 215.2,
  7: 215.0,
  8: 214.8,
  9: 214.9,
  10: 215.1,
  11: 214.7,
  12: 215.0,
  13: 214.8,
  14: 215.1,
  15: 214.6,
  17: 214.8,
  18: 215.2,
  19: 214.7,
  20: 215.0,
};

export async function seedIfEmpty(): Promise<void> {
  if (process.env.STEADY_RESEED === "1" && process.env.NODE_ENV !== "production") {
    await pool.query(`TRUNCATE TABLE
      sets, session_exercises, sessions, meals, favorites, weights,
      program_exercises, exercise_substitutes, program_days, exercises, settings
      RESTART IDENTITY CASCADE`);
  }
  const existing = await rows<{ id: number }>(pool, "SELECT id FROM settings WHERE id = 1");
  if (existing.length) return;

  const today = civilDate(new Date());
  const monday = weekStartCivil(today);
  const includeSamples = process.env.NODE_ENV !== "production" || process.env.SEED_SAMPLES === "1";

  await tx(async (client) => {
    for (const exercise of EXERCISES) {
      await client.query(
        `INSERT INTO exercises (id, name, pattern_key, pattern_label, muscles, is_cardio, measure)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          exercise.id,
          exercise.name,
          exercise.patternKey,
          exercise.patternLabel,
          exercise.muscles,
          Boolean(exercise.isCardio),
          exercise.measure ?? "reps",
        ],
      );
    }
    for (const [exerciseId, subs] of Object.entries(SUBSTITUTES)) {
      for (let index = 0; index < subs.length; index += 1) {
        await client.query(
          "INSERT INTO exercise_substitutes (exercise_id, substitute_id, sort_order) VALUES ($1,$2,$3)",
          [exerciseId, subs[index], index],
        );
      }
    }
    for (let dayIndex = 0; dayIndex < DAYS.length; dayIndex += 1) {
      const day = DAYS[dayIndex];
      await client.query("INSERT INTO program_days (id, name, summary, sort_order) VALUES ($1,$2,$3,$4)", [
        day.id,
        day.name,
        day.summary,
        dayIndex,
      ]);
      for (let slotIndex = 0; slotIndex < day.slots.length; slotIndex += 1) {
        const slot = day.slots[slotIndex];
        await client.query(
          `INSERT INTO program_exercises (
             day_id, exercise_id, sort_order, sets, reps_label, rep_count, measure, per_side, notes, is_cardio, cardio_min
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            day.id,
            slot.exerciseId,
            slotIndex,
            slot.sets,
            slot.repsLabel,
            slot.repCount,
            slot.measure ?? "reps",
            Boolean(slot.perSide),
            slot.notes ?? null,
            Boolean(slot.isCardio),
            slot.cardioMin ?? null,
          ],
        );
      }
    }
    await client.query(
      `INSERT INTO settings (id, display_name, kcal_target, protein_target, carb_target, fat_target, weight_target, ramp)
       VALUES (1,$1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        DEFAULT_SETTINGS.displayName,
        DEFAULT_SETTINGS.calories,
        DEFAULT_SETTINGS.protein,
        DEFAULT_SETTINGS.carbs,
        DEFAULT_SETTINGS.fat,
        DEFAULT_SETTINGS.weightLb,
        JSON.stringify(DEFAULT_SETTINGS.ramp),
      ],
    );
    for (let index = 0; index < FAVORITES.length; index += 1) {
      const [name, calories, protein, carbs, fat, note] = FAVORITES[index];
      await client.query(
        `INSERT INTO favorites (id, name, calories, protein, carbs, fat, note, last_used_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [randomUUID(), name, calories, protein, carbs, fat, note, new Date(Date.now() - index * 3_600_000)],
      );
    }
    if (!includeSamples) return;

    const meals = [
      ["06:20", today, "Eggs, oats, and berries", 680, 38, 72, 24, "3 eggs, 80 g oats, berries, splash of milk"],
      ["09:45", today, "Protein shake and banana", 320, 42, 28, 6, "Fairlife and a scoop"],
      ["12:30", today, "Chicken rice bowl", 740, 58, 70, 22, "About 200 g chicken, rice, salsa"],
      ["07:05", addDays(today, -1), "Overnight oats", 510, 30, 70, 14, null],
      ["18:40", addDays(today, -1), "Salmon, potatoes, and greens", 690, 48, 45, 32, null],
    ] as const;
    for (const [time, date, name, calories, protein, carbs, fat, note] of meals) {
      await client.query(
        `INSERT INTO meals (id, logged_at, name, calories, protein, carbs, fat, note, sample)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)`,
        [randomUUID(), wallTimeToUtc(date, time), name, calories, protein, carbs, fat, note],
      );
    }
    for (const [age, weight] of Object.entries(WEIGHT_BY_AGE)) {
      const date = addDays(today, -Number(age));
      await client.query(
        `INSERT INTO weights (id, weighed_on, weight_lb, weighed_at, sample) VALUES ($1,$2,$3,$4,true)`,
        [randomUUID(), date, weight, wallTimeToUtc(date, age === "0" ? "06:50" : "07:00")],
      );
    }

    const slots = await rows<{
      id: number;
      day_id: string;
      exercise_id: string;
      sets: number;
      rep_count: number;
      reps_label: string;
      measure: string;
      per_side: boolean;
      notes: string | null;
      is_cardio: boolean;
      cardio_min: number | null;
      sort_order: number;
      name: string;
    }>(
      client,
      `SELECT pe.id, pe.day_id, pe.exercise_id, pe.sets, pe.rep_count, pe.reps_label, pe.measure, pe.per_side,
              pe.notes, pe.is_cardio, pe.cardio_min, pe.sort_order, e.name
       FROM program_exercises pe JOIN exercises e ON e.id = pe.exercise_id
       ORDER BY pe.sort_order`,
    );
    const history = new Map<string, Perf[]>();
    for (const item of SAMPLE_PLAN) {
      const date = addDays(monday, item.dayOffset - item.weeksAgo * 7);
      if (date >= today) continue;
      const day = DAYS.find((entry) => entry.id === item.dayId);
      if (!day) continue;
      const started = wallTimeToUtc(date, "05:35");
      const sessionId = randomUUID();
      await client.query(
        `INSERT INTO sessions (id, day_id, name, started_at, completed_at, week_start, sample)
         VALUES ($1,$2,$3,$4,$5,$6,true)`,
        [sessionId, day.id, day.name, started, new Date(started.getTime() + 55 * 60_000), weekStartCivil(date)],
      );
      const daySlots = slots.filter((slot) => slot.day_id === day.id);
      let tick = 0;
      for (const slot of daySlots) {
        const sxId = randomUUID();
        await client.query(
          `INSERT INTO session_exercises (
             id, session_id, program_exercise_id, exercise_id, name, sort_order, sets, reps_label, rep_count,
             measure, per_side, notes, is_cardio, cardio_min
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            sxId,
            sessionId,
            slot.id,
            slot.exercise_id,
            slot.name,
            slot.sort_order,
            slot.sets,
            slot.reps_label,
            slot.rep_count,
            slot.measure,
            slot.per_side,
            slot.notes,
            slot.is_cardio,
            slot.cardio_min,
          ],
        );
        for (let setIndex = 1; setIndex <= slot.sets; setIndex += 1) {
          tick += 1;
          const loggedAt = new Date(started.getTime() + tick * 60_000);
          if (slot.is_cardio) {
            await client.query(
              `INSERT INTO sets (id, session_exercise_id, exercise_id, set_index, duration_sec, note, is_pr, logged_at)
               VALUES ($1,$2,$3,$4,$5,$6,false,$7)`,
              [randomUUID(), sxId, slot.exercise_id, setIndex, (slot.cardio_min ?? 10) * 60, slot.notes, loggedAt],
            );
            continue;
          }
          const weightLb = workingWeight(slot.exercise_id, item.adjust);
          const perf = { weightLb, reps: slot.rep_count };
          const prior = history.get(slot.exercise_id) ?? [];
          const pr = detectPr(prior, perf);
          history.set(slot.exercise_id, [...prior, perf]);
          await client.query(
            `INSERT INTO sets (
               id, session_exercise_id, exercise_id, set_index, weight_lb, reps, is_pr, pr_kind, logged_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [randomUUID(), sxId, slot.exercise_id, setIndex, weightLb, slot.rep_count, pr.isPr, pr.kind, loggedAt],
          );
        }
      }
    }
  });
}
