import type { Macros, Ramp } from "./logic";

export type MealDTO = {
  id: string;
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  note: string | null;
  photo: string | null;
  loggedAt: string;
  timeLabel: string;
  date: string;
};

export type FavoriteDTO = {
  id: string;
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  note: string | null;
};

export type SetDTO = {
  id: string;
  setIndex: number;
  weightLb: number | null;
  reps: number | null;
  durationSec: number | null;
  note: string | null;
  isPr: boolean;
  prKind: "weight" | "e1rm" | null;
  loggedAt: string | null;
  label: string;
};

export type SessionExerciseDTO = {
  id: string;
  exerciseId: string;
  name: string;
  patternLabel: string;
  muscles: string;
  sortOrder: number;
  isCardio: boolean;
  setsPlanned: number;
  repsLabel: string;
  repCount: number;
  measure: string;
  perSide: boolean;
  notes: string | null;
  cardioMin: number | null;
  lastTime: string;
  lastWeightLb: number | null;
  prLine: string;
  swaps: { id: string; name: string }[];
  sets: SetDTO[];
};

export type SessionDTO = {
  id: string;
  dayId: string | null;
  name: string;
  startedAt: string;
  completedAt: string | null;
  weekStart: string;
  rampNote: string | null;
  exercises: SessionExerciseDTO[];
};

export type DayDTO = {
  id: string;
  name: string;
  summary: string;
  status: "done" | "in_progress" | "todo";
  suggested: boolean;
  doneWeekday: string | null;
  sessionId: string | null;
  exercises: { name: string; detail: string; isCardio: boolean }[];
};

export type WeekDTO = {
  weekStart: string;
  weekEnd: string;
  rangeLabel: string;
  doneCount: number;
  total: number;
  rampNote: string | null;
  days: DayDTO[];
};

export type WidgetTodayDTO = {
  date: string;
  updatedAt: string;
  calories: { eaten: number; target: number; left: number };
  protein: { eaten: number; target: number };
  carbs: { eaten: number; target: number };
  fat: { eaten: number; target: number };
};

export type TodayDTO = {
  date: string;
  dateLabel: string;
  greeting: string;
  targets: Macros & { weightLb: number };
  totals: Macros;
  left: Macros;
  meals: MealDTO[];
  suggestion: null | {
    dayId: string;
    name: string;
    status: "todo" | "in_progress" | "done";
    sessionId: string | null;
    rampNote: string | null;
    summary: string;
    lines: string[];
  };
  weekDone: number;
  weekTotal: number;
};

export type SettingsDTO = {
  displayName: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  weightLb: number;
  ramp: Ramp;
  rampNote: string | null;
  aiConfigured: boolean;
  samples: boolean;
};

export type FoodDayDTO = {
  date: string;
  today: string;
  nowTime: string;
  meals: MealDTO[];
  favorites: FavoriteDTO[];
  aiConfigured: boolean;
};

export type WeightPoint = { date: string; weightLb: number | null; average: number | null };

export type WeightDTO = {
  target: number;
  average: number | null;
  count: number;
  change: number | null;
  hint: { tone: "steady" | "up" | "down" | "wait"; text: string };
  today: number | null;
  points: WeightPoint[];
};

export type HistoryItem = {
  id: string;
  name: string;
  date: string;
  dateLabel: string;
  weekday: string;
  durationLabel: string;
  prCount: number;
  finished: boolean;
};

export type ExerciseHistoryDTO = {
  id: string;
  name: string;
  measure: string;
  best: null | { label: string; e1rm: number | null; dateLabel: string };
  chartLabel: string;
  series: { date: string; value: number; label: string }[];
  sessions: {
    sessionId: string;
    dateLabel: string;
    workoutName: string;
    sets: { label: string; isPr: boolean }[];
  }[];
};

export type GlucoseDTO =
  | {
      available: false;
      reason?: string;
      detail?: string;
      mgdl?: number;
      arrow?: string;
      label?: string;
      at?: string;
      minutesAgo?: number;
    }
  | {
      available: true;
      mgdl: number;
      arrow: string;
      label: string;
      at: string;
      minutesAgo: number;
    };
