/** How far from the start or finish a reading can be and still count as that moment. */
export const GLUCOSE_MATCH_MS = 15 * 60 * 1000;

/** Readings after the workout, included in the summary and the sparkline. */
export const GLUCOSE_AFTER_MS = 2 * 60 * 60 * 1000;

/** A sparkline breaks when two readings are farther apart than this. */
export const SPARK_GAP_MINUTES = 12;

export type CgmReading = { at: number; mgdl: number };

export type WorkoutGlucosePoint = { minute: number; mgdl: number };

export type WorkoutGlucose = {
  /** The two-hour window after finishing is still open. */
  inProgress: boolean;
  /** Nightscout could not be read, and nothing is stored yet. */
  unavailable: boolean;
  startMgdl: number | null;
  endMgdl: number | null;
  averageMgdl: number | null;
  lowDuringMgdl: number | null;
  lowAfterMgdl: number | null;
  workoutMinutes: number;
  windowMinutes: number;
  /** Minutes from the start of the workout. The workout itself is `0..workoutMinutes`. */
  points: WorkoutGlucosePoint[];
};

export function glucoseBand(mgdl: number | null): "low" | "high" | "ok" {
  if (mgdl == null || !Number.isFinite(mgdl)) return "ok";
  if (mgdl < 120) return "low";
  if (mgdl > 180) return "high";
  return "ok";
}

function roundMinute(ms: number): number {
  return Math.round((ms / 60_000) * 10) / 10;
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

function averageMgdl(entries: CgmReading[]): number | null {
  if (entries.length === 0) return null;
  const sum = entries.reduce((total, entry) => total + entry.mgdl, 0);
  return Math.round(sum / entries.length);
}

function lowestMgdl(entries: CgmReading[]): number | null {
  if (entries.length === 0) return null;
  return entries.reduce((min, entry) => Math.min(min, entry.mgdl), entries[0].mgdl);
}

/**
 * Summarize CGM readings for one finished workout.
 * `entries` may include up to 15 minutes before the start. Readings after
 * `min(now, completedAt + 2h)` are ignored. Missing stretches stay null.
 */
export function summarizeWorkoutGlucose(input: {
  startedAt: number;
  completedAt: number;
  now: number;
  entries: CgmReading[];
}): WorkoutGlucose {
  const startedAt = input.startedAt;
  const completedAt = input.completedAt;
  const windowEnd = completedAt + GLUCOSE_AFTER_MS;
  const cap = Math.min(input.now, windowEnd);
  const visible = cleanReadings(input.entries).filter((entry) => entry.at <= cap);
  const during = visible.filter((entry) => entry.at >= startedAt && entry.at <= completedAt);
  const after = visible.filter((entry) => entry.at > completedAt);
  const points: WorkoutGlucosePoint[] = [];
  for (const entry of visible) {
    if (entry.at < startedAt) continue;
    const minute = Math.round(((entry.at - startedAt) / 60_000) * 100) / 100;
    const last = points[points.length - 1];
    if (last && last.minute === minute) last.mgdl = entry.mgdl;
    else points.push({ minute, mgdl: entry.mgdl });
  }
  const workoutMinutes = Math.max(0, roundMinute(completedAt - startedAt));
  return {
    inProgress: input.now < windowEnd,
    unavailable: false,
    startMgdl: closestMgdl(visible, startedAt),
    endMgdl: closestMgdl(visible, completedAt),
    averageMgdl: averageMgdl(during),
    lowDuringMgdl: lowestMgdl(during),
    lowAfterMgdl: lowestMgdl(after),
    workoutMinutes,
    windowMinutes: Math.round((workoutMinutes + GLUCOSE_AFTER_MS / 60_000) * 10) / 10,
    points,
  };
}

export function blankWorkoutGlucose(startedAt: number, completedAt: number, now: number, unavailable: boolean): WorkoutGlucose {
  return { ...summarizeWorkoutGlucose({ startedAt, completedAt, now, entries: [] }), unavailable };
}

export function shouldPersistWorkoutGlucose(summary: WorkoutGlucose): boolean {
  return !summary.inProgress && !summary.unavailable;
}

function mgdlField(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 20 && value <= 500) return value;
  return undefined;
}

/** Accept a stored snapshot. Partial or in-progress payloads are rejected so they can be fetched again. */
export function storedWorkoutGlucose(value: unknown): WorkoutGlucose | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.inProgress !== false || row.unavailable !== false) return null;
  const startMgdl = mgdlField(row.startMgdl);
  const endMgdl = mgdlField(row.endMgdl);
  const averageMgdl = mgdlField(row.averageMgdl);
  const lowDuringMgdl = mgdlField(row.lowDuringMgdl);
  const lowAfterMgdl = mgdlField(row.lowAfterMgdl);
  if (
    startMgdl === undefined ||
    endMgdl === undefined ||
    averageMgdl === undefined ||
    lowDuringMgdl === undefined ||
    lowAfterMgdl === undefined
  ) {
    return null;
  }
  if (typeof row.workoutMinutes !== "number" || typeof row.windowMinutes !== "number") return null;
  if (!Number.isFinite(row.workoutMinutes) || !Number.isFinite(row.windowMinutes)) return null;
  if (row.workoutMinutes < 0 || row.windowMinutes < row.workoutMinutes) return null;
  if (!Array.isArray(row.points) || row.points.length > 1000) return null;
  const points: WorkoutGlucosePoint[] = [];
  for (const point of row.points) {
    if (!point || typeof point !== "object") return null;
    const item = point as Record<string, unknown>;
    const mgdl = mgdlField(item.mgdl);
    if (mgdl == null || typeof item.minute !== "number" || !Number.isFinite(item.minute) || item.minute < 0) return null;
    points.push({ minute: item.minute, mgdl });
  }
  return {
    inProgress: false,
    unavailable: false,
    startMgdl,
    endMgdl,
    averageMgdl,
    lowDuringMgdl,
    lowAfterMgdl,
    workoutMinutes: row.workoutMinutes,
    windowMinutes: row.windowMinutes,
    points,
  };
}

/** Split the sparkline where a gap is longer than `gapMinutes`. */
export function sparklinePaths(points: WorkoutGlucosePoint[], gapMinutes = SPARK_GAP_MINUTES): WorkoutGlucosePoint[][] {
  const sorted = [...points].sort((a, b) => a.minute - b.minute || a.mgdl - b.mgdl);
  const groups: WorkoutGlucosePoint[][] = [];
  let current: WorkoutGlucosePoint[] = [];
  for (const point of sorted) {
    const prev = current[current.length - 1];
    if (prev && point.minute - prev.minute > gapMinutes) {
      groups.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
