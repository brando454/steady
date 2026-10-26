import { GLUCOSE_MATCH_MS, SPARK_GAP_MINUTES, sparklinePaths, type CgmReading, type WorkoutGlucosePoint } from "./workoutGlucose";

/** Readings kept before the meal, for the sparkline only. */
export const MEAL_GLUCOSE_BEFORE_MS = 30 * 60 * 1000;

/** Post-meal window for the peak, the low, and the sparkline. */
export const MEAL_GLUCOSE_AFTER_MS = 3 * 60 * 60 * 1000;

export const MEAL_GLUCOSE_BEFORE_MIN = MEAL_GLUCOSE_BEFORE_MS / 60_000;
export const MEAL_GLUCOSE_AFTER_MIN = MEAL_GLUCOSE_AFTER_MS / 60_000;

export type MealGlucosePoint = { minute: number; mgdl: number };

export type MealGlucose = {
  /** The three-hour window after the meal is still open. */
  inProgress: boolean;
  /** Nightscout could not be read, and nothing is stored yet. */
  unavailable: boolean;
  /** Sensor glucose closest to the meal time. */
  atMgdl: number | null;
  /** Highest reading from the meal through three hours after. */
  peakMgdl: number | null;
  /** Minutes after the meal when that peak happened. */
  peakMinute: number | null;
  /** Peak minus the reading at meal time. */
  riseMgdl: number | null;
  /** Lowest reading from the meal through three hours after. */
  lowAfterMgdl: number | null;
  /** Minutes from the meal. Negative minutes are before it. */
  points: MealGlucosePoint[];
};

export type DayGlucosePoint = { minute: number; mgdl: number };

export type DayMarker = {
  id: string;
  kind: "meal" | "workout";
  name: string;
  minute: number;
  mgdl: number | null;
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
};

export type DayGlucose = {
  unavailable: boolean;
  /** Minutes from local midnight to now. */
  spanMinutes: number;
  points: DayGlucosePoint[];
  markers: DayMarker[];
};

function roundMinute(ms: number): number {
  return Math.round((ms / 60_000) * 100) / 100;
}

function cleanReadings(entries: CgmReading[]): CgmReading[] {
  const out: CgmReading[] = [];
  for (const entry of entries) {
    if (!Number.isFinite(entry.at) || !Number.isFinite(entry.mgdl)) continue;
    const mgdl = Math.round(entry.mgdl);
    if (mgdl < 20 || mgdl > 500) continue;
    out.push({ at: entry.at, mgdl });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

function closestMgdl(entries: CgmReading[], target: number): number | null {
  let best: { at: number; mgdl: number; dist: number } | null = null;
  for (const entry of entries) {
    const dist = Math.abs(entry.at - target);
    if (dist > GLUCOSE_MATCH_MS) continue;
    if (!best || dist < best.dist || (dist === best.dist && entry.at < best.at)) {
      best = { at: entry.at, mgdl: entry.mgdl, dist };
    }
  }
  return best ? best.mgdl : null;
}

function pushPoint(points: MealGlucosePoint[], minute: number, mgdl: number): void {
  const last = points[points.length - 1];
  if (last && last.minute === minute) last.mgdl = mgdl;
  else points.push({ minute, mgdl });
}

/**
 * Summarize CGM readings around one meal.
 * The sparkline runs from 30 minutes before the meal to three hours after.
 * Peak, rise, and the low use the meal time through those three hours.
 * Readings after `min(now, meal + 3h)` are ignored.
 */
export function summarizeMealGlucose(input: {
  loggedAt: number;
  now: number;
  entries: CgmReading[];
}): MealGlucose {
  const loggedAt = input.loggedAt;
  const windowEnd = loggedAt + MEAL_GLUCOSE_AFTER_MS;
  const cap = Math.min(input.now, windowEnd);
  const from = loggedAt - MEAL_GLUCOSE_BEFORE_MS;
  const visible = cleanReadings(input.entries).filter((entry) => entry.at >= from && entry.at <= cap);
  const after = visible.filter((entry) => entry.at >= loggedAt);
  const points: MealGlucosePoint[] = [];
  for (const entry of visible) {
    pushPoint(points, roundMinute(entry.at - loggedAt), entry.mgdl);
  }
  let peak: CgmReading | null = null;
  let low: number | null = null;
  for (const entry of after) {
    if (!peak || entry.mgdl > peak.mgdl || (entry.mgdl === peak.mgdl && entry.at < peak.at)) peak = entry;
    low = low == null ? entry.mgdl : Math.min(low, entry.mgdl);
  }
  const atMgdl = closestMgdl(visible, loggedAt);
  const peakMgdl = peak ? peak.mgdl : null;
  const peakMinute = peak ? Math.round((peak.at - loggedAt) / 60_000) : null;
  return {
    inProgress: input.now < windowEnd,
    unavailable: false,
    atMgdl,
    peakMgdl,
    peakMinute,
    riseMgdl: atMgdl == null || peakMgdl == null ? null : peakMgdl - atMgdl,
    lowAfterMgdl: low,
    points,
  };
}

export function blankMealGlucose(loggedAt: number, now: number, unavailable: boolean): MealGlucose {
  return { ...summarizeMealGlucose({ loggedAt, now, entries: [] }), unavailable };
}

export function shouldPersistMealGlucose(summary: MealGlucose): boolean {
  return !summary.inProgress && !summary.unavailable;
}

function mgdlField(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 20 && value <= 500) return value;
  return undefined;
}

function minuteField(value: unknown, max: number): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max) return value;
  return undefined;
}

/** Accept a stored snapshot. In-progress or partial payloads are rejected so they can be fetched again. */
export function storedMealGlucose(value: unknown): MealGlucose | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.inProgress !== false || row.unavailable !== false) return null;
  const atMgdl = mgdlField(row.atMgdl);
  const peakMgdl = mgdlField(row.peakMgdl);
  const lowAfterMgdl = mgdlField(row.lowAfterMgdl);
  const peakMinute = minuteField(row.peakMinute, MEAL_GLUCOSE_AFTER_MIN);
  const riseMgdl = row.riseMgdl === null ? null : typeof row.riseMgdl === "number" && Number.isInteger(row.riseMgdl) ? row.riseMgdl : undefined;
  if (atMgdl === undefined || peakMgdl === undefined || lowAfterMgdl === undefined || peakMinute === undefined || riseMgdl === undefined) {
    return null;
  }
  if ((peakMgdl == null) !== (peakMinute == null)) return null;
  if ((atMgdl == null || peakMgdl == null) !== (riseMgdl == null)) return null;
  if (atMgdl != null && peakMgdl != null && riseMgdl !== peakMgdl - atMgdl) return null;
  if (!Array.isArray(row.points) || row.points.length > 1000) return null;
  const points: MealGlucosePoint[] = [];
  for (const point of row.points) {
    if (!point || typeof point !== "object") return null;
    const item = point as Record<string, unknown>;
    const mgdl = mgdlField(item.mgdl);
    if (mgdl == null || typeof item.minute !== "number" || !Number.isFinite(item.minute)) return null;
    if (item.minute < -MEAL_GLUCOSE_BEFORE_MIN - 1 || item.minute > MEAL_GLUCOSE_AFTER_MIN + 1) return null;
    points.push({ minute: item.minute, mgdl });
  }
  return {
    inProgress: false,
    unavailable: false,
    atMgdl,
    peakMgdl,
    peakMinute,
    riseMgdl,
    lowAfterMgdl,
    points,
  };
}

export function mealSparklinePaths(points: MealGlucosePoint[]): MealGlucosePoint[][] {
  return sparklinePaths(points as WorkoutGlucosePoint[], SPARK_GAP_MINUTES);
}

export function mealGlucoseLine(summary: MealGlucose): string {
  if (summary.unavailable) return "Glucose unavailable";
  if (summary.atMgdl == null && summary.peakMgdl == null) {
    return summary.inProgress ? "Glucose in progress" : "No glucose yet";
  }
  const at = summary.atMgdl == null ? "—" : String(summary.atMgdl);
  const peak = summary.peakMgdl == null ? "—" : String(summary.peakMgdl);
  const rise = summary.riseMgdl == null ? "" : ` · ${summary.riseMgdl > 0 ? "+" : ""}${summary.riseMgdl}`;
  const state = summary.inProgress ? " · in progress" : "";
  return `${at} → ${peak}${rise}${state}`;
}

function dayPoints(entries: CgmReading[], startMs: number, cap: number): DayGlucosePoint[] {
  const points: DayGlucosePoint[] = [];
  for (const entry of cleanReadings(entries)) {
    if (entry.at < startMs || entry.at > cap) continue;
    const minute = roundMinute(entry.at - startMs);
    const last = points[points.length - 1];
    if (last && last.minute === minute) last.mgdl = entry.mgdl;
    else points.push({ minute, mgdl: entry.mgdl });
  }
  return points;
}

/** Y value for a marker. Prefer a point on the line, including a short interpolation across a gap-free stretch. */
export function glucoseOnLine(points: DayGlucosePoint[], minute: number): number | null {
  if (points.length === 0 || !Number.isFinite(minute)) return null;
  let before: DayGlucosePoint | null = null;
  let after: DayGlucosePoint | null = null;
  for (const point of points) {
    if (point.minute <= minute) before = point;
    if (point.minute >= minute) {
      after = point;
      break;
    }
  }
  if (before && after) {
    if (before.minute === after.minute) return before.mgdl;
    const gap = after.minute - before.minute;
    if (gap <= SPARK_GAP_MINUTES) {
      const t = (minute - before.minute) / gap;
      return Math.round(before.mgdl + (after.mgdl - before.mgdl) * t);
    }
    const closer = minute - before.minute <= after.minute - minute ? before : after;
    return Math.abs(closer.minute - minute) <= GLUCOSE_MATCH_MS / 60_000 ? closer.mgdl : null;
  }
  const only = before ?? after;
  if (!only || Math.abs(only.minute - minute) > GLUCOSE_MATCH_MS / 60_000) return null;
  return only.mgdl;
}

export function summarizeDayGlucose(input: {
  startMs: number;
  now: number;
  entries: CgmReading[];
  meals: { id: string; name: string; at: number; calories: number; protein: number; carbs: number; fat: number }[];
  workouts: { id: string; name: string; at: number }[];
}): DayGlucose {
  const spanMinutes = Math.max(0, roundMinute(input.now - input.startMs));
  const points = dayPoints(input.entries, input.startMs, input.now);
  const markers: DayMarker[] = [];
  for (const meal of input.meals) {
    const minute = roundMinute(meal.at - input.startMs);
    if (minute < -1 || minute > spanMinutes + 1) continue;
    markers.push({
      id: meal.id,
      kind: "meal",
      name: meal.name,
      minute: Math.max(0, Math.min(spanMinutes, minute)),
      mgdl: glucoseOnLine(points, minute),
      calories: meal.calories,
      protein: meal.protein,
      carbs: meal.carbs,
      fat: meal.fat,
    });
  }
  for (const workout of input.workouts) {
    const minute = roundMinute(workout.at - input.startMs);
    if (minute < -1 || minute > spanMinutes + 1) continue;
    markers.push({
      id: workout.id,
      kind: "workout",
      name: workout.name,
      minute: Math.max(0, Math.min(spanMinutes, minute)),
      mgdl: glucoseOnLine(points, minute),
    });
  }
  markers.sort((a, b) => a.minute - b.minute || a.name.localeCompare(b.name));
  return { unavailable: false, spanMinutes, points, markers };
}

export function blankDayGlucose(startMs: number, now: number): DayGlucose {
  return { ...summarizeDayGlucose({ startMs, now, entries: [], meals: [], workouts: [] }), unavailable: true };
}
