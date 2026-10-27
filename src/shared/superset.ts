export type SupersetSplit = {
  fromId: string;
  group: string;
  movementIds: [string, string];
};

/** Combined plan slots that used to be one exercise. "A or B" stays a single lift. */
export const PLAN_SUPERSETS: SupersetSplit[] = [
  { fromId: "face-pull-lateral", group: "ss-face-lateral", movementIds: ["face-pull", "lateral-raise"] },
  { fromId: "curl-pushdown", group: "ss-curl-pushdown", movementIds: ["db-curl", "pushdown"] },
];

export function supersetTitle(names: string[]): string {
  return `Superset · ${names.join(" + ")}`;
}

export type Groupable = {
  id: string | number;
  name: string;
  sets: number;
  repsLabel: string;
  isCardio: boolean;
  notes: string | null;
  supersetGroup: string | null;
  supersetOrder: number | null;
  sortOrder: number;
};

export type PreviewLine = {
  name: string;
  detail: string;
  isCardio: boolean;
};

export function programPreview(slots: Groupable[]): PreviewLine[] {
  const ordered = [...slots].sort((a, b) => a.sortOrder - b.sortOrder || (a.supersetOrder ?? 0) - (b.supersetOrder ?? 0));
  const used = new Set<string | number>();
  const lines: PreviewLine[] = [];
  for (const slot of ordered) {
    if (used.has(slot.id)) continue;
    if (slot.supersetGroup) {
      const members = ordered
        .filter((item) => item.supersetGroup === slot.supersetGroup)
        .sort((a, b) => (a.supersetOrder ?? 0) - (b.supersetOrder ?? 0) || a.sortOrder - b.sortOrder);
      for (const member of members) used.add(member.id);
      lines.push({
        name: supersetTitle(members.map((member) => member.name)),
        detail: `${slot.sets}×${slot.repsLabel}`,
        isCardio: false,
      });
      continue;
    }
    used.add(slot.id);
    lines.push({
      name: slot.name,
      detail: slot.isCardio ? slot.notes || slot.repsLabel : `${slot.sets}×${slot.repsLabel}`,
      isCardio: slot.isCardio,
    });
  }
  return lines;
}

export type Block<T> =
  | { kind: "single"; exercise: T }
  | { kind: "superset"; group: string; title: string; exercises: T[] };

export function exerciseBlocks<T extends { name: string; supersetGroup: string | null; supersetOrder: number | null; sortOrder: number }>(
  exercises: T[],
): Block<T>[] {
  const ordered = [...exercises].sort((a, b) => a.sortOrder - b.sortOrder || (a.supersetOrder ?? 0) - (b.supersetOrder ?? 0));
  const used = new Set<T>();
  const blocks: Block<T>[] = [];
  for (const exercise of ordered) {
    if (used.has(exercise)) continue;
    if (!exercise.supersetGroup) {
      used.add(exercise);
      blocks.push({ kind: "single", exercise });
      continue;
    }
    const members = ordered
      .filter((item) => item.supersetGroup === exercise.supersetGroup)
      .sort((a, b) => (a.supersetOrder ?? 0) - (b.supersetOrder ?? 0) || a.sortOrder - b.sortOrder);
    for (const member of members) used.add(member);
    blocks.push({
      kind: "superset",
      group: exercise.supersetGroup,
      title: supersetTitle(members.map((member) => member.name)),
      exercises: members,
    });
  }
  return blocks;
}

export function restSecondsForReps(reps: number): number {
  if (reps <= 6) return 150;
  if (reps <= 10) return 90;
  return 60;
}

/** Rest starts after the whole round. The heavier (lower-rep) movement sets the clock. */
export function restSecondsForRound(reps: number[]): number {
  const usable = reps.filter((value) => Number.isFinite(value) && value > 0);
  if (usable.length === 0) return 60;
  return restSecondsForReps(Math.min(...usable));
}

export function roundIndexes(members: { sets: { setIndex: number }[] }[]): number[] {
  const indexes = new Set<number>();
  for (const member of members) {
    for (const set of member.sets) indexes.add(set.setIndex);
  }
  return [...indexes].sort((a, b) => a - b);
}
