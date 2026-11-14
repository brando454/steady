import { HttpError } from "../util";
import { round1, type Nutrients } from "./nutrients";

/** Mifflin-St Jeor, then a standard activity factor, then a small goal adjustment. */
const ACTIVITY: Record<string, number> = {
  sedentary: 1.2,
  mostly_seated: 1.2,
  "mostly seated": 1.2,
  light: 1.375,
  on_my_feet: 1.375,
  "on my feet": 1.375,
  moderate: 1.55,
  active: 1.55,
  very_active: 1.725,
  "very active": 1.725,
  extra: 1.9,
};

const GOAL_KCAL: Record<string, number> = {
  maintain: 0,
  lose: -250,
  lose_gently: -250,
  "lose gently": -250,
  build: 250,
  build_muscle: 250,
  "build muscle": 250,
};

const PROTEIN_PER_KG: Record<string, number> = {
  maintain: 1.8,
  lose: 2,
  lose_gently: 2,
  "lose gently": 2,
  build: 2.2,
  build_muscle: 2.2,
  "build muscle": 2.2,
};

export type SuggestInput = {
  sex: string;
  age: number;
  heightCm: number;
  weightKg: number;
  activity: string;
  goal: string;
};

export function suggestTargets(input: SuggestInput): Nutrients {
  const sex = input.sex.trim().toLowerCase();
  const activity = ACTIVITY[input.activity.trim().toLowerCase()];
  const goalKey = input.goal.trim().toLowerCase();
  const goalKcal = GOAL_KCAL[goalKey];
  const proteinPerKg = PROTEIN_PER_KG[goalKey];
  if (activity == null || goalKcal == null || proteinPerKg == null) throw new HttpError(400, "Activity or goal looks off");
  if (!Number.isFinite(input.age) || input.age < 13 || input.age > 100) throw new HttpError(400, "Age looks off");
  if (!Number.isFinite(input.heightCm) || input.heightCm < 100 || input.heightCm > 250) throw new HttpError(400, "Height looks off");
  if (!Number.isFinite(input.weightKg) || input.weightKg < 30 || input.weightKg > 300) throw new HttpError(400, "Weight looks off");

  const base = 10 * input.weightKg + 6.25 * input.heightCm - 5 * input.age;
  const bmr = sex === "male" || sex === "m" ? base + 5 : sex === "female" || sex === "f" ? base - 161 : Number.NaN;
  if (!Number.isFinite(bmr)) throw new HttpError(400, "Sex looks off");

  const kcal = Math.max(1000, Math.round(bmr * activity + goalKcal));
  const protein = round1(proteinPerKg * input.weightKg);
  const fatKcal = kcal * 0.3;
  const fat = round1(fatKcal / 9);
  const carbKcal = Math.max(0, kcal - protein * 4 - fat * 9);
  const carbs = round1(carbKcal / 4);
  const fiber = round1((kcal / 1000) * 14);
  return { kcal, protein_g: protein, carbs_g: carbs, fat_g: fat, fiber_g: fiber };
}
