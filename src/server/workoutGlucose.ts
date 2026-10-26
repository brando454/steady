import { GLUCOSE_AFTER_MS, GLUCOSE_MATCH_MS, blankWorkoutGlucose, shouldPersistWorkoutGlucose, storedWorkoutGlucose, summarizeWorkoutGlucose, type WorkoutGlucose } from "../shared/workoutGlucose";
import { pool } from "./db";
import { readGlucoseRange } from "./nightscout";

type SessionClock = {
  id: string;
  startedAt: Date;
  completedAt: Date | null;
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
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

async function loadSummary(id: string, startedAt: number, completedAt: number, now: number): Promise<WorkoutGlucose> {
  const from = startedAt - GLUCOSE_MATCH_MS;
  const to = Math.min(now, completedAt + GLUCOSE_AFTER_MS);
  if (to < from) return blankWorkoutGlucose(startedAt, completedAt, now, true);
  const read = await readGlucoseRange(from, to);
  if (!read.ok) return blankWorkoutGlucose(startedAt, completedAt, now, true);
  const summary = summarizeWorkoutGlucose({ startedAt, completedAt, now, entries: read.entries });
  if (shouldPersistWorkoutGlucose(summary)) {
    try {
      await pool.query(
        "UPDATE sessions SET glucose_summary = $2::jsonb WHERE id = $1 AND glucose_summary IS NULL",
        [id, JSON.stringify(summary)],
      );
    } catch {
      console.warn("Workout glucose snapshot was not saved");
    }
  }
  return summary;
}

/**
 * Glucose for finished sessions. A closed window is stored on the session.
 * Nightscout is read with GET only, and a failed read is not stored.
 */
export async function glucoseForSessions(sessions: SessionClock[], now = Date.now()): Promise<Map<string, WorkoutGlucose | null>> {
  const out = new Map<string, WorkoutGlucose | null>();
  const pending: SessionClock[] = [];
  for (const session of sessions) {
    if (!session.completedAt) {
      out.set(session.id, null);
      continue;
    }
    const stored = storedWorkoutGlucose(session.stored);
    if (stored) {
      out.set(session.id, stored);
      continue;
    }
    pending.push(session);
  }
  await mapPool(pending, 4, async (session) => {
    const completedAt = session.completedAt;
    if (!completedAt) {
      out.set(session.id, null);
      return;
    }
    const summary = await loadSummary(session.id, session.startedAt.getTime(), completedAt.getTime(), now);
    out.set(session.id, summary);
  });
  return out;
}

export async function glucoseForSession(session: SessionClock, now = Date.now()): Promise<WorkoutGlucose | null> {
  const map = await glucoseForSessions([session], now);
  return map.get(session.id) ?? null;
}
