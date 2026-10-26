import { addDays, daysBetween, weekStartCivil } from "./time";

export type Macros = {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

export type Perf = {
  weightLb: number | null;
  reps: number | null;
};

export type PrKind = "weight" | "e1rm";

export function dailyTotals(meals: Macros[]): Macros {
  return meals.reduce(
    (total, meal) => ({
      calories: total.calories + meal.calories,
      protein: total.protein + meal.protein,
      carbs: total.carbs + meal.carbs,
      fat: total.fat + meal.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
}

export function macrosLeft(totals: Macros, targets: Macros): Macros {
  return {
    calories: targets.calories - totals.calories,
    protein: targets.protein - totals.protein,
    carbs: targets.carbs - totals.carbs,
    fat: targets.fat - totals.fat,
  };
}

/** Same eaten, target, and calories-left numbers the Today screen shows. */
export function widgetToday(date: string, updatedAt: string, totals: Macros, targets: Macros) {
  const left = macrosLeft(totals, targets);
  return {
    date,
    updatedAt,
    calories: { eaten: totals.calories, target: targets.calories, left: left.calories },
    protein: { eaten: totals.protein, target: targets.protein },
    carbs: { eaten: totals.carbs, target: targets.carbs },
    fat: { eaten: totals.fat, target: targets.fat },
  };
}

/** Epley estimated 1RM. Bodyweight (no load) has no estimate. */
export function epley(weightLb: number, reps: number): number {
  if (!(weightLb > 0) || !(reps > 0)) return 0;
  if (reps <= 1) return weightLb;
  return weightLb * (1 + reps / 30);
}

export function detectPr(history: Perf[], set: Perf): { isPr: boolean; kind: PrKind | null } {
  const prior = history.filter((item) => item.weightLb != null && item.reps != null && item.reps > 0);
  if (
    prior.length === 0 ||
    set.weightLb == null ||
    set.reps == null ||
    !(set.reps > 0) ||
    set.weightLb < 0
  ) {
    return { isPr: false, kind: null };
  }

  const sameReps = prior.filter((item) => item.reps === set.reps);
  if (sameReps.length > 0 && set.weightLb > Math.max(...sameReps.map((item) => item.weightLb as number))) {
    return { isPr: true, kind: "weight" };
  }

  const mine = epley(set.weightLb, set.reps);
  const best = Math.max(...prior.map((item) => epley(item.weightLb as number, item.reps as number)));
  if (mine > best + 0.05) return { isPr: true, kind: "e1rm" };

  const anyLoad = set.weightLb > 0 || prior.some((item) => (item.weightLb as number) > 0);
  if (!anyLoad && set.reps > Math.max(...prior.map((item) => item.reps as number))) {
    return { isPr: true, kind: "e1rm" };
  }

  return { isPr: false, kind: null };
}

export function annotatePrs<T extends Perf>(sets: T[]): (T & { isPr: boolean; kind: PrKind | null })[] {
  const history: Perf[] = [];
  const annotated = [];
  for (const set of sets) {
    const pr = detectPr(history, set);
    annotated.push({ ...set, isPr: pr.isPr, kind: pr.kind });
    if (set.weightLb != null && set.reps != null && set.reps > 0) history.push(set);
  }
  return annotated;
}

export function bestSet<T extends Perf>(sets: T[]): T | null {
  let best: T | null = null;
  for (const set of sets) {
    if (set.weightLb == null || set.reps == null) continue;
    if (!best || comparePerf(set, best) > 0) best = set;
  }
  return best;
}

function comparePerf(a: Perf, b: Perf): number {
  const estimate = epley(a.weightLb ?? 0, a.reps ?? 0) - epley(b.weightLb ?? 0, b.reps ?? 0);
  if (Math.abs(estimate) > 0.05) return estimate;
  const load = (a.weightLb ?? 0) - (b.weightLb ?? 0);
  if (load !== 0) return load;
  return (a.reps ?? 0) - (b.reps ?? 0);
}

export type WeighIn = { date: string; weightLb: number };

export function sevenDayAverage(entries: WeighIn[], asOf: string): { average: number; count: number } | null {
  const start = addDays(asOf, -6);
  const window = entries.filter((entry) => entry.date >= start && entry.date <= asOf);
  if (window.length === 0) return null;
  const sum = window.reduce((total, entry) => total + entry.weightLb, 0);
  return { average: sum / window.length, count: window.length };
}

export function averageChange(entries: WeighIn[], asOf: string): number | null {
  const now = sevenDayAverage(entries, asOf);
  const previous = sevenDayAverage(entries, addDays(asOf, -7));
  if (!now || !previous) return null;
  return now.average - previous.average;
}

export function weightHint(change: number | null): { tone: "steady" | "up" | "down" | "wait"; text: string } {
  if (change == null) {
    return {
      tone: "wait",
      text: "A few more weigh-ins and this will compare the last 7 days with the 7 before.",
    };
  }
  const shown = Math.abs(change).toFixed(1);
  if (change > 0.5) {
    return {
      tone: "up",
      text: `The average is up ${shown} lb this week. Consider dropping 150 kcal.`,
    };
  }
  if (change < -0.5) {
    return {
      tone: "down",
      text: `The average is down ${shown} lb this week. Keeping calories is reasonable while you hold weight.`,
    };
  }
  return { tone: "steady", text: "Holding steady. Keep calories where they are." };
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export type DayStatus = "done" | "in_progress" | "todo";

export type SessionMark = {
  dayId: string;
  weekStart: string;
  completed: boolean;
};

export function weekDayStatuses(
  dayIds: string[],
  sessions: SessionMark[],
  weekStart: string,
): { dayId: string; status: DayStatus }[] {
  return dayIds.map((dayId) => {
    const mine = sessions.filter((session) => session.dayId === dayId && session.weekStart === weekStart);
    if (mine.some((session) => !session.completed)) return { dayId, status: "in_progress" };
    if (mine.some((session) => session.completed)) return { dayId, status: "done" };
    return { dayId, status: "todo" };
  });
}

export function suggestedDayId(statuses: { dayId: string; status: DayStatus }[]): string | null {
  return statuses.find((status) => status.status !== "done")?.dayId ?? null;
}

export type TodayFocus = {
  dayId: string;
  sessionId: string | null;
  /** Finished on the current America/Boise civil day. Tomorrow this becomes the next workout. */
  completedToday: boolean;
};

/**
 * Today shows the workout finished on this Boise day until the date changes.
 * An open session still wins, so a resume is not covered by an earlier finish.
 * `completedToday` must be newest first and already filtered to the Boise civil date.
 */
export function todayFocus(
  statuses: { dayId: string; status: DayStatus }[],
  completedToday: { dayId: string; sessionId: string }[],
): TodayFocus | null {
  const open = statuses.find((status) => status.status === "in_progress");
  if (open) return { dayId: open.dayId, sessionId: null, completedToday: false };
  const done = completedToday.find((item) => statuses.some((status) => status.dayId === item.dayId));
  if (done) return { dayId: done.dayId, sessionId: done.sessionId, completedToday: true };
  const next = suggestedDayId(statuses);
  if (!next) return null;
  return { dayId: next, sessionId: null, completedToday: false };
}

export function dayDoneLine(sets: number, prs: number): string {
  const parts: string[] = [];
  if (sets === 1) parts.push("1 set");
  else if (sets > 1) parts.push(`${sets} sets`);
  if (prs === 1) parts.push("1 new PR");
  else if (prs > 1) parts.push(`${prs} new PRs`);
  return parts.join(" · ");
}

/** The burst plays once, the first time this finish is seen, and never when motion is reduced. */
export function shouldCelebrate(alreadySeen: boolean, reduceMotion: boolean): boolean {
  return !alreadySeen && !reduceMotion;
}

export type MealEntryFields = {
  name: string;
  calories: string;
  protein: string;
  carbs: string;
  fat: string;
  note: string;
  photo: string | null;
  estimateImage?: string | null;
};

/** The meal card keeps its hint until a photo, note, or any meal field has something in it. */
export function mealEntryIsBlank(entry: MealEntryFields): boolean {
  const blank = (value: string | null | undefined) => !value || value.trim() === "";
  return (
    blank(entry.photo) &&
    blank(entry.estimateImage) &&
    blank(entry.note) &&
    blank(entry.name) &&
    blank(entry.calories) &&
    blank(entry.protein) &&
    blank(entry.carbs) &&
    blank(entry.fat)
  );
}

export type UsualSnapshot = {
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  note: string | null;
};

export type UsualForm = {
  name: string;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  note: string;
};

/** Editing a filled usual stays local. The button offers an update only when that saved meal's name is still the one on the form and something changed. */
export function usualActionLabel(loaded: UsualSnapshot | null, form: UsualForm): "Save as usual" | "Update usual" {
  if (!loaded) return "Save as usual";
  const sameName = form.name.trim().toLowerCase() === loaded.name.trim().toLowerCase();
  if (!sameName) return "Save as usual";
  const same =
    form.calories === loaded.calories &&
    form.protein === loaded.protein &&
    form.carbs === loaded.carbs &&
    form.fat === loaded.fat &&
    form.note === (loaded.note ?? "");
  return same ? "Save as usual" : "Update usual";
}

export type Ramp = {
  startDate: string;
  weeks: { offset: number; percent: number }[];
};

export function rampForDate(ramp: Ramp, civil: string): { percent: number; note: string } | null {
  const start = weekStartCivil(ramp.startDate);
  const current = weekStartCivil(civil);
  const offset = Math.round(daysBetween(start, current) / 7);
  const match = ramp.weeks.find((week) => week.offset === offset);
  if (!match) return null;
  return {
    percent: match.percent,
    note: `Ramp week · about ${match.percent}% of your usual weights.`,
  };
}

export function greetingFor(hour: number, name: string): string {
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  return `Good ${part}, ${name}`;
}
