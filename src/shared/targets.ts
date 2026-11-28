import { formatPerformance } from "./format";
import { suggestedDayId, type DayStatus } from "./logic";

export type DayMark = { dayId: string; status: DayStatus };

/** The workout the app would open next: an in-progress day, otherwise the first day not done, otherwise the first day again next week. */
export function nextPlannedDay(dayIds: string[], statuses: DayMark[]): { dayId: string; open: boolean; wrapped: boolean } | null {
  if (!dayIds.length) return null;
  const open = statuses.find((status) => status.status === "in_progress");
  if (open) return { dayId: open.dayId, open: true, wrapped: false };
  const next = suggestedDayId(statuses);
  if (next) return { dayId: next, open: false, wrapped: false };
  return { dayId: dayIds[0], open: false, wrapped: true };
}

export function latestLoggedWeight(
  rows: { exerciseId: string; loggedAt: number; weightLb: number | null }[],
  exerciseId: string,
): number | null {
  let found: { loggedAt: number; weightLb: number | null } | null = null;
  for (const row of rows) {
    if (row.exerciseId !== exerciseId) continue;
    if (!found || row.loggedAt > found.loggedAt) found = row;
  }
  return found ? found.weightLb : null;
}

export type PrefillInput = {
  isCardio: boolean;
  sets: number;
  repCount: number;
  repsLabel: string;
  measure: string;
  perSide: boolean;
  /** Most recent logged set's weight. This is what a new session writes into every set. */
  latestWeightLb: number | null;
  /** Best set of the previous session, the same pair the session screen calls last time. */
  last: { weightLb: number | null; reps: number | null } | null;
};

/** The numbers a new session prefills, matching startSession and the iOS set fields. */
export function prefillTarget(input: PrefillInput) {
  const lastTime = input.isCardio || !input.last ? null : formatPerformance(input.last.weightLb, input.last.reps, input.measure, input.perSide);
  return {
    targetSets: input.sets,
    targetWeightLb: input.isCardio ? null : input.latestWeightLb,
    targetReps: input.isCardio ? null : input.repCount,
    repsLabel: input.repsLabel,
    lastTime: lastTime === "—" ? null : lastTime,
    lastWeightLb: input.last?.weightLb ?? null,
    lastReps: input.last?.reps ?? null,
  };
}
