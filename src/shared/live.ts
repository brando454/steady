export type LiveSet = {
  id: string;
  setIndex: number;
  skipped: boolean;
  loggedAt: string | null;
  weightLb: number | null;
  reps: number | null;
};

export type LiveExercise = {
  name: string;
  skipped: boolean;
  isCardio: boolean;
  setsPlanned: number;
  repsLabel: string;
  measure: string;
  perSide: boolean;
  supersetGroup: string | null;
  supersetOrder: number | null;
  sortOrder: number;
  sets: LiveSet[];
};

export type LiveDraft = { weight: string; reps: string; minutes: string };

export type LiveLine = {
  headline: string;
  detail: string;
  shortName: string;
};

export function setIsOpen(exercise: { skipped: boolean }, set: { loggedAt: string | null; skipped: boolean }): boolean {
  return !exercise.skipped && set.loggedAt == null && !set.skipped;
}

function trimNum(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function draftNumber(value: string | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function planned(exercise: LiveExercise, set: LiveSet, draft: LiveDraft | undefined): { weight: number | null; reps: number | null } {
  const weight = draftNumber(draft?.weight) ?? set.weightLb;
  const reps = draftNumber(draft?.reps) ?? set.reps;
  if (exercise.isCardio) {
    const minutes = draftNumber(draft?.minutes);
    return { weight: null, reps: minutes ?? (set.reps ?? null) };
  }
  return { weight, reps };
}

/** Weight and reps for the line. No weight falls back to the program's rep target. */
export function targetPhrase(
  weight: number | null,
  reps: number | null,
  repsLabel: string,
  withUnit: boolean,
  perSide = false,
): string {
  const side = perSide ? " /side" : "";
  const repsText = reps != null ? trimNum(reps) : repsLabel;
  if (weight == null) return `${repsText}${side}`;
  return withUnit ? `${trimNum(weight)} lb × ${repsText}${side}` : `${trimNum(weight)} × ${repsText}${side}`;
}

function piece(exercise: LiveExercise, set: LiveSet, draft: LiveDraft | undefined, withUnit: boolean): string {
  if (exercise.isCardio) return exercise.repsLabel;
  const values = planned(exercise, set, draft);
  const order = exercise.supersetOrder === 1 ? "A1 " : exercise.supersetOrder === 2 ? "A2 " : "";
  const phrase = exercise.measure === "meters"
    ? values.weight == null
      ? `${values.reps ?? exercise.repsLabel} m`
      : `${trimNum(values.weight)} lb × ${values.reps ?? exercise.repsLabel} m`
    : targetPhrase(values.weight, values.reps, exercise.repsLabel, withUnit, exercise.perSide);
  return `${order}${exercise.name} ${phrase}`.trim();
}

function ordered(exercises: LiveExercise[]): LiveExercise[] {
  return [...exercises].sort((a, b) => a.sortOrder - b.sortOrder || (a.supersetOrder ?? 0) - (b.supersetOrder ?? 0));
}

export function nextOpen(exercises: LiveExercise[]): { exercise: LiveExercise; set: LiveSet } | null {
  for (const exercise of ordered(exercises)) {
    if (exercise.skipped) continue;
    const set = [...exercise.sets].sort((a, b) => a.setIndex - b.setIndex).find((item) => setIsOpen(exercise, item));
    if (set) return { exercise, set };
  }
  return null;
}

function roundMates(exercises: LiveExercise[], exercise: LiveExercise, set: LiveSet): { exercise: LiveExercise; set: LiveSet }[] {
  if (!exercise.supersetGroup) return [{ exercise, set }];
  const members = ordered(exercises).filter((item) => item.supersetGroup === exercise.supersetGroup && !item.skipped);
  const mates = members.flatMap((member) => {
    const match = member.sets.find((item) => item.setIndex === set.setIndex && setIsOpen(member, item));
    return match ? [{ exercise: member, set: match }] : [];
  });
  return mates.length ? mates : [{ exercise, set }];
}

export function liveLine(exercises: LiveExercise[], drafts: Record<string, LiveDraft> = {}): LiveLine | null {
  const open = nextOpen(exercises);
  if (!open) return null;
  const mates = roundMates(exercises, open.exercise, open.set);
  if (mates.length > 1) {
    const round = mates.map((mate) => piece(mate.exercise, mate.set, drafts[mate.set.id], false)).join(" · ");
    return {
      headline: `Set ${open.set.setIndex} · ${round}`,
      detail: `Next: ${round}`,
      shortName: "Superset",
    };
  }
  const exercise = open.exercise;
  const values = planned(exercise, open.set, drafts[open.set.id]);
  const phrase = exercise.isCardio
    ? exercise.repsLabel
    : exercise.measure === "meters"
      ? values.weight == null
        ? `${values.reps ?? exercise.repsLabel} m`
        : `${trimNum(values.weight)} lb × ${values.reps ?? exercise.repsLabel} m`
      : targetPhrase(values.weight, values.reps, exercise.repsLabel, true, exercise.perSide);
  const headline = exercise.isCardio
    ? `${exercise.name} · ${phrase}`
    : `${exercise.name} · Set ${open.set.setIndex} of ${exercise.setsPlanned} · ${phrase}`;
  const nextPhrase = exercise.isCardio ? phrase : targetPhrase(values.weight, values.reps, exercise.repsLabel, true, exercise.perSide);
  return {
    headline,
    detail: `Next: ${exercise.name} ${nextPhrase}`,
    shortName: exercise.name,
  };
}

export function completedSetCount(exercises: { sets: { loggedAt: string | null }[] }[]): number {
  return exercises.reduce((sum, exercise) => sum + exercise.sets.filter((set) => set.loggedAt != null).length, 0);
}
