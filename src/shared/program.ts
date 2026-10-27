import type { Ramp } from "./logic";

export type ExerciseSeed = {
  id: string;
  name: string;
  patternKey: string;
  patternLabel: string;
  muscles: string;
  isCardio?: boolean;
  measure?: "reps" | "meters" | "cardio";
};

export type SlotSeed = {
  exerciseId: string;
  sets: number;
  repsLabel: string;
  repCount: number;
  measure?: "reps" | "meters" | "cardio";
  perSide?: boolean;
  notes?: string;
  isCardio?: boolean;
  cardioMin?: number;
  supersetGroup?: string;
  supersetOrder?: number;
};

export type DaySeed = {
  id: string;
  name: string;
  summary: string;
  slots: SlotSeed[];
};

const lift = (
  id: string,
  name: string,
  patternKey: string,
  patternLabel: string,
  muscles: string,
  measure: "reps" | "meters" = "reps",
): ExerciseSeed => ({ id, name, patternKey, patternLabel, muscles, measure });

export const EXERCISES: ExerciseSeed[] = [
  lift("back-squat", "Back squat", "squat", "Squat", "Quads, glutes"),
  lift("hack-squat", "Hack squat", "squat", "Squat", "Quads, glutes"),
  lift("leg-press", "Leg press", "squat", "Squat", "Quads, glutes"),
  lift("smith-squat", "Smith squat", "squat", "Squat", "Quads, glutes"),
  lift("goblet-squat", "Goblet squat", "squat", "Squat", "Quads, glutes"),
  lift("front-squat", "Front squat", "squat", "Squat", "Quads, glutes"),
  lift("safety-bar-squat", "Safety bar squat", "squat", "Squat", "Quads, glutes"),
  lift("bulgarian-split-squat", "Bulgarian split squat", "split-squat", "Split squat", "Quads, glutes"),
  lift("walking-lunge", "Walking lunge", "split-squat", "Split squat", "Quads, glutes"),
  lift("reverse-lunge", "Reverse lunge", "split-squat", "Split squat", "Quads, glutes"),
  lift("step-up", "Step-up", "split-squat", "Split squat", "Quads, glutes"),
  lift("goblet-or-lunge", "Goblet squat or walking lunge", "squat", "Squat", "Quads, glutes"),
  lift("bench-press", "Bench press", "horizontal-push", "Horizontal push", "Chest, triceps"),
  lift("db-bench", "DB bench press", "horizontal-push", "Horizontal push", "Chest, triceps"),
  lift("machine-chest-press", "Machine chest press", "horizontal-push", "Horizontal push", "Chest, triceps"),
  lift("push-up", "Push-up", "horizontal-push", "Horizontal push", "Chest, triceps"),
  lift("smith-bench", "Smith bench press", "horizontal-push", "Horizontal push", "Chest, triceps"),
  lift("pushup-or-press", "Push-up or machine press", "horizontal-push", "Horizontal push", "Chest, triceps"),
  lift("db-incline-press", "DB incline press", "incline-push", "Incline push", "Upper chest, shoulders"),
  lift("incline-barbell", "Incline barbell press", "incline-push", "Incline push", "Upper chest, shoulders"),
  lift("machine-incline", "Machine incline press", "incline-push", "Incline push", "Upper chest, shoulders"),
  lift("overhead-press", "Overhead press", "vertical-push", "Vertical push", "Shoulders, triceps"),
  lift("db-shoulder-press", "DB shoulder press", "vertical-push", "Vertical push", "Shoulders, triceps"),
  lift("machine-shoulder", "Machine shoulder press", "vertical-push", "Vertical push", "Shoulders, triceps"),
  lift("landmine-press", "Landmine press", "vertical-push", "Vertical push", "Shoulders, triceps"),
  lift("dip", "Dip", "dip", "Dip", "Chest, triceps"),
  lift("machine-dip", "Machine dip", "dip", "Dip", "Chest, triceps"),
  lift("close-grip-bench", "Close-grip bench", "dip", "Dip", "Triceps, chest"),
  lift("rdl", "Romanian deadlift", "hinge", "Hinge", "Hamstrings, glutes"),
  lift("db-rdl", "Dumbbell RDL", "hinge", "Hinge", "Hamstrings, glutes"),
  lift("good-morning", "Good morning", "hinge", "Hinge", "Hamstrings, glutes"),
  lift("back-extension", "Back extension", "hinge", "Hinge", "Hamstrings, glutes"),
  lift("hip-thrust", "Hip thrust", "hinge", "Hinge", "Glutes"),
  lift("trap-bar-deadlift", "Trap bar deadlift", "hinge", "Hinge", "Posterior chain"),
  lift("conventional-deadlift", "Conventional deadlift", "hinge", "Hinge", "Posterior chain"),
  lift("rack-pull", "Rack pull", "hinge", "Hinge", "Back, glutes"),
  lift("barbell-row", "Barbell row", "horizontal-pull", "Horizontal pull", "Back"),
  lift("chest-supported-row", "Chest-supported row", "horizontal-pull", "Horizontal pull", "Back"),
  lift("sa-db-row", "Single-arm DB row", "horizontal-pull", "Horizontal pull", "Back"),
  lift("seated-cable-row", "Seated cable row", "horizontal-pull", "Horizontal pull", "Back"),
  lift("dumbbell-row", "Dumbbell row", "horizontal-pull", "Horizontal pull", "Back"),
  lift("lat-pulldown", "Lat pulldown", "vertical-pull", "Vertical pull", "Lats"),
  lift("weighted-pull-up", "Weighted pull-up", "vertical-pull", "Vertical pull", "Lats"),
  lift("pull-up", "Pull-up", "vertical-pull", "Vertical pull", "Lats"),
  lift("assisted-pull-up", "Assisted pull-up", "vertical-pull", "Vertical pull", "Lats"),
  lift("neutral-pulldown", "Neutral-grip pulldown", "vertical-pull", "Vertical pull", "Lats"),
  lift("chin-up", "Chin-up", "vertical-pull", "Vertical pull", "Lats, biceps"),
  lift("lateral-raise", "Lateral raise", "lateral-raise", "Lateral raise", "Shoulders"),
  lift("cable-lateral", "Cable lateral raise", "lateral-raise", "Lateral raise", "Shoulders"),
  lift("machine-lateral", "Machine lateral raise", "lateral-raise", "Lateral raise", "Shoulders"),
  lift("db-y-raise", "DB Y raise", "lateral-raise", "Lateral raise", "Shoulders"),
  lift("face-pull-lateral", "Face pull + lateral raise", "rear-delt", "Rear delt", "Rear shoulders"),
  lift("reverse-fly", "Reverse fly", "rear-delt", "Rear delt", "Rear shoulders"),
  lift("band-pull-apart", "Band pull-apart", "rear-delt", "Rear delt", "Rear shoulders"),
  lift("face-pull", "Face pull", "rear-delt", "Rear delt", "Rear shoulders"),
  lift("rear-delt-machine", "Rear-delt machine", "rear-delt", "Rear delt", "Rear shoulders"),
  lift("leg-curl", "Leg curl", "knee-flexion", "Knee flexion", "Hamstrings"),
  lift("seated-leg-curl", "Seated leg curl", "knee-flexion", "Knee flexion", "Hamstrings"),
  lift("swiss-ball-curl", "Swiss ball leg curl", "knee-flexion", "Knee flexion", "Hamstrings"),
  lift("nordic-curl", "Nordic curl", "knee-flexion", "Knee flexion", "Hamstrings"),
  lift("curl-pushdown", "DB curl + pushdown", "arms", "Arms", "Biceps, triceps"),
  lift("db-curl", "DB curl", "curl", "Curl", "Biceps"),
  lift("barbell-curl", "Barbell curl", "curl", "Curl", "Biceps"),
  lift("hammer-curl-single", "Hammer curl", "curl", "Curl", "Biceps"),
  lift("machine-curl", "Machine curl", "curl", "Curl", "Biceps"),
  lift("pushdown", "Pushdown", "pushdown", "Pushdown", "Triceps"),
  lift("cable-pushdown", "Cable pushdown", "pushdown", "Pushdown", "Triceps"),
  lift("overhead-extension", "Overhead extension", "pushdown", "Pushdown", "Triceps"),
  lift("rope-pushdown", "Rope pushdown", "pushdown", "Pushdown", "Triceps"),
  lift("barbell-curl-pushdown", "Barbell curl + cable pushdown", "arms", "Arms", "Biceps, triceps"),
  lift("hammer-curl", "Hammer curl + overhead extension", "arms", "Arms", "Biceps, triceps"),
  lift("machine-curl-pushdown", "Machine curl + rope pushdown", "arms", "Arms", "Biceps, triceps"),
  lift("hanging-leg-raise", "Hanging leg raise", "core", "Core", "Abs, hip flexors"),
  lift("captains-chair", "Captain's chair leg raise", "core", "Core", "Abs, hip flexors"),
  lift("lying-leg-raise", "Lying leg raise", "core", "Core", "Abs"),
  lift("ab-wheel", "Ab wheel", "core", "Core", "Abs"),
  lift("pallof-or-crunch", "Pallof press or cable crunch", "core", "Core", "Abs"),
  lift("dead-bug", "Dead bug", "core", "Core", "Abs"),
  lift("cable-crunch", "Cable crunch", "core", "Core", "Abs"),
  lift("hanging-knee-raise", "Hanging knee raise", "core", "Core", "Abs"),
  lift("calf-raise", "Calf raise", "calves", "Calves", "Calves"),
  lift("seated-calf", "Seated calf raise", "calves", "Calves", "Calves"),
  lift("single-leg-calf", "Single-leg calf raise", "calves", "Calves", "Calves"),
  lift("leg-press-calf", "Leg press calf raise", "calves", "Calves", "Calves"),
  lift("farmer-carry", "Farmer carry", "carry", "Carry", "Grip, trunk", "meters"),
  lift("suitcase-carry", "Suitcase carry", "carry", "Carry", "Grip, trunk", "meters"),
  lift("trap-bar-carry", "Trap bar carry", "carry", "Carry", "Grip, trunk", "meters"),
  lift("rack-carry", "Rack carry", "carry", "Carry", "Trunk", "meters"),
  {
    id: "easy-cardio",
    name: "Easy cardio",
    patternKey: "cardio",
    patternLabel: "Cardio",
    muscles: "Easy",
    isCardio: true,
    measure: "cardio",
  },
  {
    id: "bike-intervals",
    name: "Bike intervals",
    patternKey: "cardio",
    patternLabel: "Cardio",
    muscles: "Intervals",
    isCardio: true,
    measure: "cardio",
  },
  {
    id: "steady-cardio",
    name: "Steady cardio",
    patternKey: "cardio",
    patternLabel: "Cardio",
    muscles: "Steady",
    isCardio: true,
    measure: "cardio",
  },
  {
    id: "optional-intervals",
    name: "Optional intervals",
    patternKey: "cardio",
    patternLabel: "Cardio",
    muscles: "Optional",
    isCardio: true,
    measure: "cardio",
  },
];

export const SUBSTITUTES: Record<string, string[]> = {
  "back-squat": ["hack-squat", "leg-press", "smith-squat", "goblet-squat"],
  "bench-press": ["db-bench", "machine-chest-press", "push-up", "smith-bench"],
  rdl: ["db-rdl", "good-morning", "back-extension", "hip-thrust"],
  "barbell-row": ["chest-supported-row", "sa-db-row", "seated-cable-row", "dumbbell-row"],
  "lateral-raise": ["cable-lateral", "machine-lateral", "db-y-raise"],
  "hanging-leg-raise": ["captains-chair", "lying-leg-raise", "ab-wheel"],
  "bulgarian-split-squat": ["walking-lunge", "reverse-lunge", "step-up", "goblet-squat"],
  "db-incline-press": ["incline-barbell", "machine-incline", "db-bench"],
  "lat-pulldown": ["pull-up", "assisted-pull-up", "neutral-pulldown", "chin-up"],
  "farmer-carry": ["suitcase-carry", "trap-bar-carry", "rack-carry"],
  "overhead-press": ["db-shoulder-press", "machine-shoulder", "landmine-press"],
  "weighted-pull-up": ["lat-pulldown", "assisted-pull-up", "chin-up", "pull-up"],
  "leg-press": ["hack-squat", "back-squat", "smith-squat", "goblet-squat"],
  "leg-curl": ["seated-leg-curl", "swiss-ball-curl", "nordic-curl"],
  "face-pull": ["reverse-fly", "band-pull-apart", "rear-delt-machine"],
  "face-pull-lateral": ["reverse-fly", "band-pull-apart", "face-pull", "rear-delt-machine"],
  "db-curl": ["barbell-curl", "hammer-curl-single", "machine-curl"],
  pushdown: ["cable-pushdown", "overhead-extension", "rope-pushdown"],
  "curl-pushdown": ["barbell-curl-pushdown", "hammer-curl", "machine-curl-pushdown"],
  "goblet-or-lunge": ["leg-press", "bulgarian-split-squat", "step-up", "hack-squat"],
  "pushup-or-press": ["db-bench", "machine-chest-press", "smith-bench", "bench-press"],
  "sa-db-row": ["barbell-row", "seated-cable-row", "chest-supported-row", "dumbbell-row"],
  "pallof-or-crunch": ["dead-bug", "ab-wheel", "cable-crunch", "hanging-knee-raise"],
  "trap-bar-deadlift": ["conventional-deadlift", "rdl", "rack-pull", "db-rdl"],
  "front-squat": ["goblet-squat", "back-squat", "hack-squat", "safety-bar-squat"],
  dip: ["machine-dip", "close-grip-bench", "push-up", "bench-press"],
  "chest-supported-row": ["barbell-row", "seated-cable-row", "sa-db-row", "dumbbell-row"],
  "calf-raise": ["seated-calf", "single-leg-calf", "leg-press-calf"],
};

const easyCardio: SlotSeed = {
  exerciseId: "easy-cardio",
  sets: 1,
  repsLabel: "8–10 min",
  repCount: 10,
  isCardio: true,
  measure: "cardio",
  cardioMin: 10,
  notes: "8–10 min easy. Keep it conversational.",
};

export const DAYS: DaySeed[] = [
  {
    id: "a",
    name: "Full Body A",
    summary: "Squat, bench, hinge, and a row, then easy cardio.",
    slots: [
      { exerciseId: "back-squat", sets: 4, repsLabel: "5", repCount: 5 },
      { exerciseId: "bench-press", sets: 4, repsLabel: "5", repCount: 5 },
      { exerciseId: "rdl", sets: 3, repsLabel: "8", repCount: 8 },
      { exerciseId: "barbell-row", sets: 3, repsLabel: "8", repCount: 8 },
      { exerciseId: "lateral-raise", sets: 3, repsLabel: "15", repCount: 15 },
      { exerciseId: "hanging-leg-raise", sets: 3, repsLabel: "12", repCount: 12 },
      easyCardio,
    ],
  },
  {
    id: "b",
    name: "Full Body B",
    summary: "Split squat, incline press, pulldown, carry, then bike intervals.",
    slots: [
      { exerciseId: "bulgarian-split-squat", sets: 3, repsLabel: "8 / side", repCount: 8, perSide: true },
      { exerciseId: "db-incline-press", sets: 3, repsLabel: "10", repCount: 10 },
      { exerciseId: "lat-pulldown", sets: 3, repsLabel: "10", repCount: 10 },
      { exerciseId: "farmer-carry", sets: 3, repsLabel: "40 m", repCount: 40, measure: "meters" },
      {
        exerciseId: "bike-intervals",
        sets: 1,
        repsLabel: "20 min",
        repCount: 20,
        isCardio: true,
        measure: "cardio",
        cardioMin: 20,
        notes: "5 min easy, 6 rounds of 20 s hard and 100 s easy, 3 min cooldown.",
      },
    ],
  },
  {
    id: "c",
    name: "Full Body C",
    summary: "Press, pull-up, legs, then easy cardio.",
    slots: [
      { exerciseId: "overhead-press", sets: 4, repsLabel: "6", repCount: 6 },
      { exerciseId: "weighted-pull-up", sets: 4, repsLabel: "6–8", repCount: 6 },
      { exerciseId: "leg-press", sets: 3, repsLabel: "10", repCount: 10 },
      { exerciseId: "leg-curl", sets: 3, repsLabel: "12", repCount: 12 },
      { exerciseId: "face-pull", sets: 3, repsLabel: "15", repCount: 15, supersetGroup: "ss-face-lateral", supersetOrder: 1 },
      { exerciseId: "lateral-raise", sets: 3, repsLabel: "15", repCount: 15, supersetGroup: "ss-face-lateral", supersetOrder: 2 },
      { exerciseId: "db-curl", sets: 3, repsLabel: "12", repCount: 12, supersetGroup: "ss-curl-pushdown", supersetOrder: 1 },
      { exerciseId: "pushdown", sets: 3, repsLabel: "12", repCount: 12, supersetGroup: "ss-curl-pushdown", supersetOrder: 2 },
      easyCardio,
    ],
  },
  {
    id: "d",
    name: "Full Body D",
    summary: "A lighter full body day, then steady cardio.",
    slots: [
      { exerciseId: "goblet-or-lunge", sets: 3, repsLabel: "12", repCount: 12 },
      { exerciseId: "pushup-or-press", sets: 3, repsLabel: "12", repCount: 12 },
      { exerciseId: "sa-db-row", sets: 3, repsLabel: "10", repCount: 10 },
      { exerciseId: "pallof-or-crunch", sets: 3, repsLabel: "12", repCount: 12 },
      {
        exerciseId: "steady-cardio",
        sets: 1,
        repsLabel: "20–25 min",
        repCount: 22,
        isCardio: true,
        measure: "cardio",
        cardioMin: 22,
        notes: "20–25 min steady. Nasal breathing if you can.",
      },
    ],
  },
  {
    id: "e",
    name: "Full Body E",
    summary: "Deadlift, front squat, dip, and a row. Intervals are optional.",
    slots: [
      { exerciseId: "trap-bar-deadlift", sets: 3, repsLabel: "5", repCount: 5 },
      { exerciseId: "front-squat", sets: 3, repsLabel: "8", repCount: 8 },
      { exerciseId: "dip", sets: 3, repsLabel: "10", repCount: 10 },
      { exerciseId: "chest-supported-row", sets: 3, repsLabel: "10", repCount: 10 },
      { exerciseId: "calf-raise", sets: 3, repsLabel: "15", repCount: 15 },
      { exerciseId: "farmer-carry", sets: 2, repsLabel: "40 m", repCount: 40, measure: "meters" },
      {
        exerciseId: "optional-intervals",
        sets: 1,
        repsLabel: "optional",
        repCount: 8,
        isCardio: true,
        measure: "cardio",
        cardioMin: 8,
        notes: "Optional. Short intervals if you have something left, or skip.",
      },
    ],
  },
];

export const BASE_WEIGHTS: Record<string, { weight: number; scale?: number }> = {
  "back-squat": { weight: 225 },
  "bench-press": { weight: 185 },
  rdl: { weight: 205 },
  "barbell-row": { weight: 155 },
  "lateral-raise": { weight: 20, scale: 0.25 },
  "hanging-leg-raise": { weight: 0, scale: 0 },
  "bulgarian-split-squat": { weight: 50, scale: 0.5 },
  "db-incline-press": { weight: 65, scale: 0.5 },
  "lat-pulldown": { weight: 140 },
  "farmer-carry": { weight: 70, scale: 0.5 },
  "overhead-press": { weight: 115 },
  "weighted-pull-up": { weight: 25, scale: 0.5 },
  "leg-press": { weight: 360, scale: 2 },
  "leg-curl": { weight: 90 },
  "face-pull": { weight: 20, scale: 0.25 },
  "face-pull-lateral": { weight: 20, scale: 0.25 },
  "db-curl": { weight: 30, scale: 0.25 },
  pushdown: { weight: 30, scale: 0.25 },
  "curl-pushdown": { weight: 30, scale: 0.25 },
  "goblet-or-lunge": { weight: 50, scale: 0.5 },
  "pushup-or-press": { weight: 40, scale: 0.5 },
  "sa-db-row": { weight: 70, scale: 0.5 },
  "pallof-or-crunch": { weight: 25, scale: 0.25 },
  "trap-bar-deadlift": { weight: 315 },
  "front-squat": { weight: 165 },
  dip: { weight: 25, scale: 0.5 },
  "chest-supported-row": { weight: 90 },
  "calf-raise": { weight: 180 },
};

export function workingWeight(exerciseId: string, adjustLb: number): number {
  const base = BASE_WEIGHTS[exerciseId];
  if (!base) return 0;
  const raw = base.weight + adjustLb * (base.scale ?? 1);
  if (raw <= 0) return 0;
  if (raw < 40) return Math.round(raw);
  return Math.round(raw / 5) * 5;
}

export const DEFAULT_RAMP: Ramp = {
  startDate: "2026-10-26",
  weeks: [
    { offset: 0, percent: 70 },
    { offset: 1, percent: 85 },
  ],
};

export const DEFAULT_SETTINGS = {
  displayName: "Brandon",
  calories: 3000,
  protein: 190,
  carbs: 330,
  fat: 85,
  weightLb: 215,
  ramp: DEFAULT_RAMP,
};

export const SAMPLE_PLAN: { weeksAgo: number; dayOffset: number; dayId: string; adjust: number }[] = [
  { weeksAgo: 3, dayOffset: 0, dayId: "a", adjust: -20 },
  { weeksAgo: 3, dayOffset: 2, dayId: "c", adjust: -20 },
  { weeksAgo: 3, dayOffset: 4, dayId: "e", adjust: -20 },
  { weeksAgo: 2, dayOffset: 0, dayId: "a", adjust: -10 },
  { weeksAgo: 2, dayOffset: 1, dayId: "b", adjust: -10 },
  { weeksAgo: 2, dayOffset: 3, dayId: "d", adjust: -10 },
  { weeksAgo: 1, dayOffset: 0, dayId: "a", adjust: -5 },
  { weeksAgo: 1, dayOffset: 2, dayId: "c", adjust: -5 },
  { weeksAgo: 1, dayOffset: 4, dayId: "e", adjust: -5 },
  { weeksAgo: 0, dayOffset: 0, dayId: "a", adjust: 0 },
  { weeksAgo: 0, dayOffset: 1, dayId: "b", adjust: 0 },
];
