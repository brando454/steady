import { randomUUID } from "crypto";
import { aiConfigured } from "./ai";
import { pool, rows, tx, type Queryable } from "./db";
import { formatPerformance, prescriptionLine } from "../shared/format";
import {
  annotatePrs,
  averageChange,
  bestSet,
  dailyTotals,
  greetingFor,
  macrosLeft,
  widgetToday,
  rampForDate,
  round1,
  sevenDayAverage,
  suggestedDayId,
  weekDayStatuses,
  weightHint,
  type Macros,
  type Perf,
  type Ramp,
} from "../shared/logic";
import {
  addDays,
  civilDate,
  eachDate,
  hourInZone,
  longCivil,
  shortCivil,
  timeLabel,
  timeValue,
  wallTimeToUtc,
  weekdayShort,
  weekStartCivil,
} from "../shared/time";
import type {
  DayDTO,
  ExerciseHistoryDTO,
  FavoriteDTO,
  FoodDayDTO,
  HistoryItem,
  MealDTO,
  SessionDTO,
  SessionExerciseDTO,
  SetDTO,
  SettingsDTO,
  TodayDTO,
  WidgetTodayDTO,
  WeekDTO,
  WeightDTO,
} from "../shared/types";
import {
  cleanText,
  cleanThumb,
  HttpError,
  optionalNumber,
  readDate,
  readNumber,
  readTime,
} from "./util";

type SettingsRow = {
  display_name: string;
  kcal_target: number;
  protein_target: number;
  carb_target: number;
  fat_target: number;
  weight_target: number;
  ramp: Ramp | string;
};

type SlotRow = {
  id: number;
  day_id: string;
  exercise_id: string;
  name: string;
  sort_order: number;
  sets: number;
  reps_label: string;
  rep_count: number;
  measure: string;
  per_side: boolean;
  notes: string | null;
  is_cardio: boolean;
  cardio_min: number | null;
  pattern_key: string;
  pattern_label: string;
  muscles: string;
};

function asRamp(value: Ramp | string): Ramp {
  return typeof value === "string" ? (JSON.parse(value) as Ramp) : value;
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stamp(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function dateOnly(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function sampleCount(client: Queryable = pool): Promise<number> {
  const found = await rows<{ n: number }>(
    client,
    `SELECT
      (SELECT COUNT(*) FROM sessions WHERE sample) +
      (SELECT COUNT(*) FROM meals WHERE sample) +
      (SELECT COUNT(*) FROM weights WHERE sample) AS n`,
  );
  return Number(found[0]?.n ?? 0);
}

export async function getSettings(): Promise<SettingsDTO> {
  const found = await rows<SettingsRow>(pool, "SELECT * FROM settings WHERE id = 1");
  if (!found[0]) throw new Error("Settings are missing");
  const ramp = asRamp(found[0].ramp);
  const today = civilDate(new Date());
  return {
    displayName: found[0].display_name,
    calories: Number(found[0].kcal_target),
    protein: Number(found[0].protein_target),
    carbs: Number(found[0].carb_target),
    fat: Number(found[0].fat_target),
    weightLb: Number(found[0].weight_target),
    ramp,
    rampNote: rampForDate(ramp, today)?.note ?? null,
    aiConfigured: aiConfigured(),
    samples: (await sampleCount()) > 0,
  };
}

export async function saveSettings(body: Record<string, unknown>): Promise<SettingsDTO> {
  const displayName = cleanText(body.displayName, "Name", 40);
  const calories = Math.round(readNumber(body.calories, "Calories", 8000));
  const protein = Math.round(readNumber(body.protein, "Protein", 500));
  const carbs = Math.round(readNumber(body.carbs, "Carbs", 1000));
  const fat = Math.round(readNumber(body.fat, "Fat", 400));
  const weightLb = readNumber(body.weightLb, "Weight", 500);
  if (calories < 1000 || protein < 20 || weightLb < 80) throw new HttpError(400, "Those targets look off");
  const rampStart = weekStartCivil(readDate(body.rampStart));
  const week1 = Math.round(readNumber(body.rampWeek1, "First ramp week", 150));
  const week2 = Math.round(readNumber(body.rampWeek2, "Second ramp week", 150));
  if (week1 < 10 || week2 < 10) throw new HttpError(400, "Ramp percents should be at least 10");
  const ramp: Ramp = {
    startDate: rampStart,
    weeks: [
      { offset: 0, percent: week1 },
      { offset: 1, percent: week2 },
    ],
  };
  await pool.query(
    `UPDATE settings
     SET display_name = $1, kcal_target = $2, protein_target = $3, carb_target = $4, fat_target = $5, weight_target = $6, ramp = $7::jsonb
     WHERE id = 1`,
    [displayName, calories, protein, carbs, fat, weightLb, JSON.stringify(ramp)],
  );
  return getSettings();
}

export async function clearSamples(): Promise<void> {
  const exerciseIds = await tx(async (client) => {
    const ids = await rows<{ exercise_id: string }>(
      client,
      `SELECT DISTINCT s.exercise_id
       FROM sets s
       JOIN session_exercises sx ON sx.id = s.session_exercise_id
       JOIN sessions sess ON sess.id = sx.session_id
       WHERE sess.sample = false AND s.logged_at IS NOT NULL`,
    );
    await client.query("DELETE FROM sessions WHERE sample = true");
    await client.query("DELETE FROM meals WHERE sample = true");
    await client.query("DELETE FROM weights WHERE sample = true");
    return ids.map((row) => row.exercise_id);
  });
  for (const exerciseId of exerciseIds) await recomputePrs(pool, exerciseId);
}

function targetsOf(settings: SettingsDTO): Macros & { weightLb: number } {
  return {
    calories: settings.calories,
    protein: settings.protein,
    carbs: settings.carbs,
    fat: settings.fat,
    weightLb: settings.weightLb,
  };
}

type MealRow = {
  id: string;
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  note: string | null;
  photo: string | null;
  logged_at: Date;
};

function mealDTO(row: MealRow, withPhoto = true): MealDTO {
  const loggedAt = row.logged_at instanceof Date ? row.logged_at : new Date(row.logged_at);
  return {
    id: row.id,
    name: row.name,
    calories: Number(row.calories),
    protein: Number(row.protein),
    carbs: Number(row.carbs),
    fat: Number(row.fat),
    note: row.note,
    photo: withPhoto ? row.photo : null,
    loggedAt: loggedAt.toISOString(),
    timeLabel: timeLabel(loggedAt),
    date: civilDate(loggedAt),
  };
}

async function mealsOn(date: string, withPhoto = true): Promise<MealDTO[]> {
  const found = await rows<MealRow>(
    pool,
    `SELECT * FROM meals
     WHERE (logged_at AT TIME ZONE 'America/Boise')::date = $1::date
     ORDER BY logged_at`,
    [date],
  );
  return found.map((row) => mealDTO(row, withPhoto));
}

type DayRow = { id: string; name: string; summary: string; sort_order: number };
type SessionMarkRow = { id: string; day_id: string; week_start: string; completed_at: Date | null; started_at: Date };

export async function getWeek(): Promise<WeekDTO> {
  const today = civilDate(new Date());
  const weekStart = weekStartCivil(today);
  const weekEnd = addDays(weekStart, 6);
  const settings = await getSettings();
  const days = await rows<DayRow>(pool, "SELECT id, name, summary, sort_order FROM program_days ORDER BY sort_order");
  const slots = await rows<SlotRow>(
    pool,
    `SELECT pe.*, e.name, e.pattern_key, e.pattern_label, e.muscles
     FROM program_exercises pe
     JOIN exercises e ON e.id = pe.exercise_id
     ORDER BY pe.sort_order`,
  );
  const sessions = await rows<SessionMarkRow>(
    pool,
    "SELECT id, day_id, week_start, completed_at, started_at FROM sessions WHERE week_start = $1",
    [weekStart],
  );
  const statuses = weekDayStatuses(
    days.map((day) => day.id),
    sessions.map((session) => ({
      dayId: session.day_id,
      weekStart: dateOnly(session.week_start),
      completed: Boolean(session.completed_at),
    })),
    weekStart,
  );
  const suggested = suggestedDayId(statuses);
  const dto: DayDTO[] = days.map((day) => {
    const status = statuses.find((item) => item.dayId === day.id)?.status ?? "todo";
    const mine = sessions.filter((session) => session.day_id === day.id);
    const active = mine.find((session) => !session.completed_at);
    const finished = mine
      .filter((session) => session.completed_at)
      .sort((a, b) => (b.completed_at?.getTime() ?? 0) - (a.completed_at?.getTime() ?? 0))[0];
    return {
      id: day.id,
      name: day.name,
      summary: day.summary,
      status,
      suggested: day.id === suggested,
      doneWeekday: finished?.completed_at ? weekdayShort(civilDate(finished.completed_at)) : null,
      sessionId: active?.id ?? null,
      exercises: slots
        .filter((slot) => slot.day_id === day.id)
        .map((slot) => ({
          name: slot.name,
          detail: slot.is_cardio ? slot.notes || slot.reps_label : `${slot.sets}×${slot.reps_label}`,
          isCardio: slot.is_cardio,
        })),
    };
  });
  return {
    weekStart,
    weekEnd,
    rangeLabel: `${shortCivil(weekStart)} – ${shortCivil(weekEnd)}`,
    doneCount: dto.filter((day) => day.status === "done").length,
    total: dto.length,
    rampNote: rampForDate(settings.ramp, today)?.note ?? null,
    days: dto,
  };
}

export async function getWidgetToday(now = new Date()): Promise<WidgetTodayDTO> {
  const date = civilDate(now);
  const settings = await getSettings();
  const meals = await mealsOn(date, false);
  const totals = dailyTotals(meals);
  const targets = targetsOf(settings);
  return widgetToday(date, now.toISOString(), totals, targets);
}

export async function getToday(): Promise<TodayDTO> {
  const now = new Date();
  const today = civilDate(now);
  const settings = await getSettings();
  const week = await getWeek();
  const meals = await mealsOn(today);
  const totals = dailyTotals(meals);
  const targets = targetsOf(settings);
  const suggested = week.days.find((day) => day.suggested) ?? null;
  const slots = suggested
    ? await rows<SlotRow>(
        pool,
        `SELECT pe.*, e.name, e.pattern_key, e.pattern_label, e.muscles
         FROM program_exercises pe JOIN exercises e ON e.id = pe.exercise_id
         WHERE pe.day_id = $1 ORDER BY pe.sort_order`,
        [suggested.id],
      )
    : [];
  return {
    date: today,
    dateLabel: longCivil(today),
    greeting: greetingFor(hourInZone(now), settings.displayName),
    targets,
    totals,
    left: macrosLeft(totals, targets),
    meals,
    suggestion: suggested
      ? {
          dayId: suggested.id,
          name: suggested.name,
          status: suggested.status,
          sessionId: suggested.sessionId,
          rampNote: week.rampNote,
          summary: suggested.summary,
          lines: slots.map((slot) => prescriptionLine(slot.name, slot.sets, slot.reps_label, slot.is_cardio, slot.notes)),
        }
      : null,
    weekDone: week.doneCount,
    weekTotal: week.total,
  };
}

type ExerciseInfo = { id: string; name: string; pattern_key: string; is_cardio: boolean };
type HistRow = { exercise_id: string; session_id: string; logged_at: Date; weight_lb: number | null; reps: number | null };
type SetRow = {
  id: string;
  session_exercise_id: string;
  exercise_id: string;
  set_index: number;
  weight_lb: number | null;
  reps: number | null;
  duration_sec: number | null;
  note: string | null;
  is_pr: boolean;
  pr_kind: string | null;
  logged_at: Date | null;
};
type SxRow = Omit<SlotRow, "id" | "day_id"> & {
  id: string;
  session_id: string;
  program_exercise_id: number | null;
};

function setLabel(set: SetRow, exercise: { is_cardio: boolean; measure: string; per_side: boolean }): string {
  if (!set.logged_at) return "";
  if (exercise.is_cardio) {
    return set.duration_sec != null ? `${Math.round(Number(set.duration_sec) / 60)} min` : "Cardio";
  }
  return formatPerformance(num(set.weight_lb), num(set.reps), exercise.measure, exercise.per_side);
}

function historyCopy(
  history: HistRow[],
  exerciseId: string,
  measure: string,
  perSide: boolean,
  currentSessionId: string,
): { lastTime: string; prLine: string; lastWeightLb: number | null } {
  const mine = history.filter((row) => row.exercise_id === exerciseId);
  if (mine.length === 0) return { lastTime: "—", prLine: "—", lastWeightLb: null };
  const previous = mine.filter((row) => row.session_id !== currentSessionId);
  const bySession = new Map<string, Perf[]>();
  let latestSession = "";
  let latestAt = -1;
  for (const row of previous) {
    const perf = { weightLb: num(row.weight_lb), reps: num(row.reps) };
    const list = bySession.get(row.session_id) ?? [];
    list.push(perf);
    bySession.set(row.session_id, list);
    const at = row.logged_at.getTime();
    if (at > latestAt) {
      latestAt = at;
      latestSession = row.session_id;
    }
  }
  const last = latestSession ? bestSet(bySession.get(latestSession) ?? []) : null;
  const best = bestSet(mine.map((row) => ({ weightLb: num(row.weight_lb), reps: num(row.reps) })));
  let lastWeightLb: number | null = null;
  let lastWeightAt = -1;
  for (const row of mine) {
    const weight = num(row.weight_lb);
    const at = row.logged_at.getTime();
    if (weight == null || at < lastWeightAt) continue;
    lastWeightAt = at;
    lastWeightLb = weight;
  }
  return {
    lastTime: last ? formatPerformance(last.weightLb, last.reps, measure, perSide) : "—",
    prLine: best ? formatPerformance(best.weightLb, best.reps, measure, perSide) : "—",
    lastWeightLb,
  };
}

function swapsFor(exerciseId: string, patternKey: string, explicit: Map<string, { id: string; name: string }[]>, catalog: ExerciseInfo[]) {
  const chosen = [...(explicit.get(exerciseId) ?? [])];
  if (chosen.length >= 3) return chosen.slice(0, 4);
  for (const exercise of catalog) {
    if (chosen.length >= 4) break;
    if (exercise.pattern_key !== patternKey || exercise.id === exerciseId || exercise.is_cardio) continue;
    if (!chosen.some((item) => item.id === exercise.id)) chosen.push({ id: exercise.id, name: exercise.name });
  }
  return chosen.slice(0, 4);
}

export async function getSession(id: string): Promise<SessionDTO | null> {
  const sessions = await rows<{
    id: string;
    day_id: string | null;
    name: string;
    started_at: Date;
    completed_at: Date | null;
    week_start: string;
  }>(pool, "SELECT id, day_id, name, started_at, completed_at, week_start FROM sessions WHERE id = $1", [id]);
  const session = sessions[0];
  if (!session) return null;
  const exercises = await rows<SxRow>(
    pool,
    `SELECT sx.id, sx.session_id, sx.program_exercise_id, sx.exercise_id, sx.name, sx.sort_order, sx.sets,
            sx.reps_label, sx.rep_count, sx.measure, sx.per_side, sx.notes, sx.is_cardio, sx.cardio_min,
            e.pattern_key, e.pattern_label, e.muscles
     FROM session_exercises sx
     JOIN exercises e ON e.id = sx.exercise_id
     WHERE sx.session_id = $1
     ORDER BY sx.sort_order, sx.name`,
    [id],
  );
  const ids = exercises.map((exercise) => exercise.id);
  const exerciseIds = [...new Set(exercises.map((exercise) => exercise.exercise_id))];
  const setRows = ids.length
    ? await rows<SetRow>(
        pool,
        "SELECT * FROM sets WHERE session_exercise_id = ANY($1::uuid[]) ORDER BY set_index",
        [ids],
      )
    : [];
  const history = exerciseIds.length
    ? await rows<HistRow>(
        pool,
        `SELECT s.exercise_id, sx.session_id, s.logged_at, s.weight_lb, s.reps
         FROM sets s
         JOIN session_exercises sx ON sx.id = s.session_exercise_id
         WHERE s.logged_at IS NOT NULL AND s.exercise_id = ANY($1::text[])`,
        [exerciseIds],
      )
    : [];
  const subRows = exerciseIds.length
    ? await rows<{ exercise_id: string; substitute_id: string; name: string }>(
        pool,
        `SELECT s.exercise_id, s.substitute_id, e.name
         FROM exercise_substitutes s
         JOIN exercises e ON e.id = s.substitute_id
         WHERE s.exercise_id = ANY($1::text[])
         ORDER BY s.sort_order`,
        [exerciseIds],
      )
    : [];
  const catalog = await rows<ExerciseInfo>(pool, "SELECT id, name, pattern_key, is_cardio FROM exercises");
  const explicit = new Map<string, { id: string; name: string }[]>();
  for (const row of subRows) {
    const list = explicit.get(row.exercise_id) ?? [];
    list.push({ id: row.substitute_id, name: row.name });
    explicit.set(row.exercise_id, list);
  }
  const settings = await getSettings();
  const dtoExercises: SessionExerciseDTO[] = exercises.map((exercise) => {
    const copy = historyCopy(history, exercise.exercise_id, exercise.measure, exercise.per_side, id);
    const sets: SetDTO[] = setRows
      .filter((set) => set.session_exercise_id === exercise.id)
      .map((set) => ({
        id: set.id,
        setIndex: set.set_index,
        weightLb: num(set.weight_lb),
        reps: num(set.reps),
        durationSec: set.duration_sec == null ? null : Number(set.duration_sec),
        note: set.note,
        isPr: set.is_pr,
        prKind: set.pr_kind === "weight" || set.pr_kind === "e1rm" ? set.pr_kind : null,
        loggedAt: stamp(set.logged_at),
        label: setLabel(set, exercise),
      }));
    return {
      id: exercise.id,
      exerciseId: exercise.exercise_id,
      name: exercise.name,
      patternLabel: exercise.pattern_label,
      muscles: exercise.muscles,
      sortOrder: exercise.sort_order,
      isCardio: exercise.is_cardio,
      setsPlanned: exercise.sets,
      repsLabel: exercise.reps_label,
      repCount: exercise.rep_count,
      measure: exercise.measure,
      perSide: exercise.per_side,
      notes: exercise.notes,
      cardioMin: exercise.cardio_min,
      lastTime: copy.lastTime,
      lastWeightLb: copy.lastWeightLb,
      prLine: copy.prLine,
      swaps: exercise.is_cardio ? [] : swapsFor(exercise.exercise_id, exercise.pattern_key, explicit, catalog),
      sets,
    };
  });
  return {
    id: session.id,
    dayId: session.day_id,
    name: session.name,
    startedAt: session.started_at.toISOString(),
    completedAt: stamp(session.completed_at),
    weekStart: dateOnly(session.week_start),
    rampNote: rampForDate(settings.ramp, civilDate(session.started_at))?.note ?? null,
    exercises: dtoExercises,
  };
}

async function requireSession(id: string): Promise<SessionDTO> {
  const session = await getSession(id);
  if (!session) throw new HttpError(404, "Workout not found");
  return session;
}

async function recomputePrs(client: Queryable, exerciseId: string): Promise<void> {
  const logged = await rows<{ id: string; weight_lb: number | null; reps: number | null }>(
    client,
    "SELECT id, weight_lb, reps FROM sets WHERE exercise_id = $1 AND logged_at IS NOT NULL ORDER BY logged_at, set_index",
    [exerciseId],
  );
  const annotated = annotatePrs(
    logged.map((row) => ({ id: row.id, weightLb: num(row.weight_lb), reps: num(row.reps) })),
  );
  for (const set of annotated) {
    await client.query("UPDATE sets SET is_pr = $1, pr_kind = $2 WHERE id = $3", [set.isPr, set.kind, set.id]);
  }
}

export async function startSession(dayId: string): Promise<SessionDTO> {
  const weekStart = weekStartCivil(civilDate(new Date()));
  const id = await tx(async (client) => {
    const existing = await rows<{ id: string }>(
      client,
      `SELECT id FROM sessions
       WHERE day_id = $1 AND week_start = $2 AND completed_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
      [dayId, weekStart],
    );
    if (existing[0]) return existing[0].id;
    const day = await rows<{ name: string }>(client, "SELECT name FROM program_days WHERE id = $1", [dayId]);
    if (!day[0]) throw new HttpError(404, "That day isn't in the program");
    const slots = await rows<SlotRow>(
      client,
      `SELECT pe.*, e.name, e.pattern_key, e.pattern_label, e.muscles
       FROM program_exercises pe JOIN exercises e ON e.id = pe.exercise_id
       WHERE pe.day_id = $1 ORDER BY pe.sort_order`,
      [dayId],
    );
    const sessionId = randomUUID();
    await client.query(
      "INSERT INTO sessions (id, day_id, name, started_at, week_start, sample) VALUES ($1, $2, $3, now(), $4, false)",
      [sessionId, dayId, day[0].name, weekStart],
    );
    for (const slot of slots) {
      const sxId = randomUUID();
      await client.query(
        `INSERT INTO session_exercises (
           id, session_id, program_exercise_id, exercise_id, name, sort_order, sets, reps_label, rep_count,
           measure, per_side, notes, is_cardio, cardio_min
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          sxId,
          sessionId,
          slot.id,
          slot.exercise_id,
          slot.name,
          slot.sort_order,
          slot.sets,
          slot.reps_label,
          slot.rep_count,
          slot.measure,
          slot.per_side,
          slot.notes,
          slot.is_cardio,
          slot.cardio_min,
        ],
      );
      const last = await rows<{ weight_lb: number | null }>(
        client,
        "SELECT weight_lb FROM sets WHERE exercise_id = $1 AND logged_at IS NOT NULL ORDER BY logged_at DESC LIMIT 1",
        [slot.exercise_id],
      );
      const weight = last[0] ? num(last[0].weight_lb) : null;
      for (let index = 1; index <= slot.sets; index += 1) {
        await client.query(
          `INSERT INTO sets (id, session_exercise_id, exercise_id, set_index, weight_lb, reps, note, is_pr)
           VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
          [
            randomUUID(),
            sxId,
            slot.exercise_id,
            index,
            slot.is_cardio ? null : weight,
            slot.is_cardio ? null : slot.rep_count,
            slot.is_cardio ? slot.notes : null,
          ],
        );
      }
    }
    return sessionId;
  });
  return requireSession(id);
}

async function openSet(client: Queryable, setId: string) {
  const found = await rows<{
    id: string;
    logged_at: Date | null;
    session_id: string;
    exercise_id: string;
    is_cardio: boolean;
    completed_at: Date | null;
    session_exercise_id: string;
  }>(
    client,
    `SELECT s.id, s.logged_at, s.session_exercise_id, sx.session_id, sx.exercise_id, sx.is_cardio, sess.completed_at
     FROM sets s
     JOIN session_exercises sx ON sx.id = s.session_exercise_id
     JOIN sessions sess ON sess.id = sx.session_id
     WHERE s.id = $1`,
    [setId],
  );
  if (!found[0]) throw new HttpError(404, "Set not found");
  if (found[0].completed_at) throw new HttpError(400, "This workout is already finished");
  return found[0];
}

export async function updatePlannedSet(setId: string, body: Record<string, unknown>): Promise<SessionDTO> {
  const sessionId = await tx(async (client) => {
    const set = await openSet(client, setId);
    if (set.logged_at) throw new HttpError(409, "That set is already logged");
    if (set.is_cardio) {
      const minutes = optionalNumber(body.minutes, "Minutes", 300);
      const note = cleanText(typeof body.note === "string" ? body.note : "", "Note", 2000, false);
      await client.query("UPDATE sets SET duration_sec = $1, note = $2 WHERE id = $3", [
        minutes == null ? null : Math.round(minutes * 60),
        note || null,
        setId,
      ]);
    } else {
      const weight = optionalNumber(body.weightLb, "Weight", 2000);
      const reps = optionalNumber(body.reps, "Reps", 500);
      await client.query("UPDATE sets SET weight_lb = $1, reps = $2 WHERE id = $3", [weight, reps, setId]);
    }
    return set.session_id;
  });
  return requireSession(sessionId);
}

export async function logSet(setId: string, body: Record<string, unknown>): Promise<SessionDTO> {
  const sessionId = await tx(async (client) => {
    const set = await openSet(client, setId);
    if (set.logged_at) throw new HttpError(409, "That set is already logged");
    if (set.is_cardio) {
      const minutes = readNumber(body.minutes, "Minutes", 300);
      if (minutes <= 0) throw new HttpError(400, "Enter the minutes");
      const note = cleanText(typeof body.note === "string" ? body.note : "", "Note", 2000, false);
      await client.query(
        "UPDATE sets SET duration_sec = $1, note = $2, exercise_id = $3, logged_at = now(), is_pr = false, pr_kind = NULL WHERE id = $4",
        [Math.round(minutes * 60), note || null, set.exercise_id, setId],
      );
    } else {
      const weight = optionalNumber(body.weightLb, "Weight", 2000);
      const reps = readNumber(body.reps, "Reps", 500);
      if (weight == null) throw new HttpError(400, "Enter the weight");
      if (reps <= 0) throw new HttpError(400, "Enter the reps");
      await client.query(
        "UPDATE sets SET weight_lb = $1, reps = $2, exercise_id = $3, logged_at = now() WHERE id = $4",
        [weight, reps, set.exercise_id, setId],
      );
      await recomputePrs(client, set.exercise_id);
    }
    return set.session_id;
  });
  return requireSession(sessionId);
}

export async function addSet(sxId: string): Promise<SessionDTO> {
  const sessionId = await tx(async (client) => {
    const sx = await rows<SxRow>(
      client,
      `SELECT sx.*, e.pattern_key, e.pattern_label, e.muscles, sess.completed_at
       FROM session_exercises sx
       JOIN exercises e ON e.id = sx.exercise_id
       JOIN sessions sess ON sess.id = sx.session_id
       WHERE sx.id = $1`,
      [sxId],
    );
    const exercise = sx[0] as (SxRow & { completed_at?: Date | null }) | undefined;
    if (!exercise) throw new HttpError(404, "Exercise not found");
    if (exercise.completed_at) throw new HttpError(400, "This workout is already finished");
    const last = await rows<{ weight_lb: number | null; reps: number | null; note: string | null; set_index: number }>(
      client,
      "SELECT weight_lb, reps, note, set_index FROM sets WHERE session_exercise_id = $1 ORDER BY set_index DESC LIMIT 1",
      [sxId],
    );
    await client.query(
      `INSERT INTO sets (id, session_exercise_id, exercise_id, set_index, weight_lb, reps, note, is_pr)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
      [
        randomUUID(),
        sxId,
        exercise.exercise_id,
        (last[0]?.set_index ?? 0) + 1,
        exercise.is_cardio ? null : num(last[0]?.weight_lb),
        exercise.is_cardio ? null : (num(last[0]?.reps) ?? exercise.rep_count),
        exercise.is_cardio ? (last[0]?.note ?? exercise.notes) : null,
      ],
    );
    return exercise.session_id;
  });
  return requireSession(sessionId);
}

export async function deleteSet(setId: string): Promise<SessionDTO> {
  const sessionId = await tx(async (client) => {
    const set = await openSet(client, setId);
    const count = await rows<{ n: number }>(
      client,
      "SELECT COUNT(*)::int AS n FROM sets WHERE session_exercise_id = $1",
      [set.session_exercise_id],
    );
    if (Number(count[0]?.n ?? 0) <= 1) throw new HttpError(400, "Keep at least one set");
    await client.query("DELETE FROM sets WHERE id = $1", [setId]);
    const remaining = await rows<{ id: string }>(
      client,
      "SELECT id FROM sets WHERE session_exercise_id = $1 ORDER BY set_index",
      [set.session_exercise_id],
    );
    for (let index = 0; index < remaining.length; index += 1) {
      await client.query("UPDATE sets SET set_index = $1 WHERE id = $2", [index + 1, remaining[index].id]);
    }
    if (set.logged_at && !set.is_cardio) await recomputePrs(client, set.exercise_id);
    return set.session_id;
  });
  return requireSession(sessionId);
}

function slugId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "exercise";
  return `${base}-${randomUUID().slice(0, 8)}`;
}

export async function swapExercise(sessionId: string, body: Record<string, unknown>): Promise<SessionDTO> {
  await tx(async (client) => {
    const sxId = cleanText(body.sessionExerciseId, "Exercise", 80);
    const scope = body.scope === "default" ? "default" : body.scope === "today" ? "today" : null;
    if (!scope) throw new HttpError(400, "Choose just today or make it the default");
    const current = await rows<SxRow & { completed_at: Date | null }>(
      client,
      `SELECT sx.*, e.pattern_key, e.pattern_label, e.muscles, sess.completed_at
       FROM session_exercises sx
       JOIN exercises e ON e.id = sx.exercise_id
       JOIN sessions sess ON sess.id = sx.session_id
       WHERE sx.id = $1 AND sx.session_id = $2`,
      [sxId, sessionId],
    );
    const exercise = current[0];
    if (!exercise) throw new HttpError(404, "Exercise not found");
    if (exercise.completed_at) throw new HttpError(400, "This workout is already finished");
    if (exercise.is_cardio) throw new HttpError(400, "Cardio stays as written");

    let nextId = typeof body.exerciseId === "string" ? body.exerciseId : "";
    const custom = typeof body.customName === "string" ? body.customName.trim() : "";
    if (custom) {
      const named = await rows<{ id: string; is_cardio: boolean }>(
        client,
        "SELECT id, is_cardio FROM exercises WHERE lower(name) = lower($1) LIMIT 1",
        [custom.slice(0, 80)],
      );
      if (named[0]) {
        if (named[0].is_cardio) throw new HttpError(400, "Pick a lifting exercise");
        nextId = named[0].id;
      } else {
        nextId = slugId(custom);
        await client.query(
          `INSERT INTO exercises (id, name, pattern_key, pattern_label, muscles, is_cardio, measure)
           VALUES ($1,$2,$3,$4,$5,false,$6)`,
          [nextId, custom.slice(0, 80), exercise.pattern_key, exercise.pattern_label, exercise.muscles, exercise.measure],
        );
      }
    }
    if (!nextId) throw new HttpError(400, "Pick an exercise");
    const next = await rows<{ id: string; name: string; is_cardio: boolean }>(
      client,
      "SELECT id, name, is_cardio FROM exercises WHERE id = $1",
      [nextId],
    );
    if (!next[0] || next[0].is_cardio) throw new HttpError(400, "Pick a lifting exercise");

    const logged = await rows<{ n: number }>(
      client,
      "SELECT COUNT(*)::int AS n FROM sets WHERE session_exercise_id = $1 AND logged_at IS NOT NULL",
      [sxId],
    );
    const loggedCount = Number(logged[0]?.n ?? 0);
    const last = await rows<{ weight_lb: number | null }>(
      client,
      "SELECT weight_lb FROM sets WHERE exercise_id = $1 AND logged_at IS NOT NULL ORDER BY logged_at DESC LIMIT 1",
      [nextId],
    );
    const weight = last[0] ? num(last[0].weight_lb) : null;

    if (loggedCount === 0) {
      await client.query("UPDATE session_exercises SET exercise_id = $1, name = $2 WHERE id = $3", [nextId, next[0].name, sxId]);
      await client.query(
        "UPDATE sets SET exercise_id = $1, weight_lb = $2, reps = $3 WHERE session_exercise_id = $4 AND logged_at IS NULL",
        [nextId, weight, exercise.rep_count, sxId],
      );
    } else {
      await client.query("DELETE FROM sets WHERE session_exercise_id = $1 AND logged_at IS NULL", [sxId]);
      await client.query(
        "UPDATE session_exercises SET sort_order = sort_order + 1 WHERE session_id = $1 AND sort_order > $2",
        [sessionId, exercise.sort_order],
      );
      const newId = randomUUID();
      const remaining = Math.max(1, exercise.sets - loggedCount);
      await client.query(
        `INSERT INTO session_exercises (
           id, session_id, program_exercise_id, exercise_id, name, sort_order, sets, reps_label, rep_count,
           measure, per_side, notes, is_cardio, cardio_min
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,$13)`,
        [
          newId,
          sessionId,
          exercise.program_exercise_id,
          nextId,
          next[0].name,
          exercise.sort_order + 1,
          remaining,
          exercise.reps_label,
          exercise.rep_count,
          exercise.measure,
          exercise.per_side,
          exercise.notes,
          exercise.cardio_min,
        ],
      );
      for (let index = 1; index <= remaining; index += 1) {
        await client.query(
          `INSERT INTO sets (id, session_exercise_id, exercise_id, set_index, weight_lb, reps, is_pr)
           VALUES ($1,$2,$3,$4,$5,$6,false)`,
          [randomUUID(), newId, nextId, index, weight, exercise.rep_count],
        );
      }
    }
    if (scope === "default" && exercise.program_exercise_id) {
      await client.query("UPDATE program_exercises SET exercise_id = $1 WHERE id = $2", [nextId, exercise.program_exercise_id]);
    }
  });
  return requireSession(sessionId);
}

export async function finishSession(id: string): Promise<SessionDTO> {
  await tx(async (client) => {
    const logged = await rows<{ n: number }>(
      client,
      `SELECT COUNT(*)::int AS n FROM sets s
       JOIN session_exercises sx ON sx.id = s.session_exercise_id
       WHERE sx.session_id = $1 AND s.logged_at IS NOT NULL`,
      [id],
    );
    if (Number(logged[0]?.n ?? 0) < 1) throw new HttpError(400, "Log a set before finishing");
    const updated = await client.query("UPDATE sessions SET completed_at = now() WHERE id = $1 AND completed_at IS NULL", [id]);
    if (updated.rowCount === 0) {
      const exists = await rows<{ id: string }>(client, "SELECT id FROM sessions WHERE id = $1", [id]);
      if (!exists[0]) throw new HttpError(404, "Workout not found");
    }
  });
  return requireSession(id);
}

export async function discardSession(id: string): Promise<void> {
  const result = await pool.query("DELETE FROM sessions WHERE id = $1", [id]);
  if (result.rowCount === 0) throw new HttpError(404, "Workout not found");
}

export async function listHistory(): Promise<HistoryItem[]> {
  const found = await rows<{
    id: string;
    name: string;
    started_at: Date;
    completed_at: Date | null;
    prs: number;
  }>(
    pool,
    `SELECT s.id, s.name, s.started_at, s.completed_at,
            (SELECT COUNT(*)::int FROM sets st
             JOIN session_exercises sx ON sx.id = st.session_exercise_id
             WHERE sx.session_id = s.id AND st.is_pr) AS prs
     FROM sessions s
     ORDER BY s.started_at DESC
     LIMIT 60`,
  );
  return found.map((session) => {
    const date = civilDate(session.started_at);
    const minutes = session.completed_at
      ? Math.max(1, Math.round((session.completed_at.getTime() - session.started_at.getTime()) / 60_000))
      : null;
    return {
      id: session.id,
      name: session.name,
      date,
      dateLabel: longCivil(date),
      weekday: weekdayShort(date),
      durationLabel: minutes == null ? "Not finished" : `${minutes} min`,
      prCount: Number(session.prs),
      finished: Boolean(session.completed_at),
    };
  });
}

export async function exerciseHistory(exerciseId: string): Promise<ExerciseHistoryDTO> {
  const exercises = await rows<{ id: string; name: string; measure: string }>(
    pool,
    "SELECT id, name, measure FROM exercises WHERE id = $1",
    [exerciseId],
  );
  const exercise = exercises[0];
  if (!exercise) throw new HttpError(404, "Exercise not found");
  const logged = await rows<{
    weight_lb: number | null;
    reps: number | null;
    logged_at: Date;
    is_pr: boolean;
    duration_sec: number | null;
    per_side: boolean;
    session_id: string;
    workout_name: string;
    started_at: Date;
  }>(
    pool,
    `SELECT s.weight_lb, s.reps, s.logged_at, s.is_pr, s.duration_sec, sx.per_side, sx.session_id,
            sess.name AS workout_name, sess.started_at
     FROM sets s
     JOIN session_exercises sx ON sx.id = s.session_exercise_id
     JOIN sessions sess ON sess.id = sx.session_id
     WHERE s.exercise_id = $1 AND s.logged_at IS NOT NULL
     ORDER BY s.logged_at`,
    [exerciseId],
  );
  const perSide = logged.some((row) => row.per_side);
  const grouped = new Map<string, typeof logged>();
  for (const row of logged) {
    const list = grouped.get(row.session_id) ?? [];
    list.push(row);
    grouped.set(row.session_id, list);
  }
  const sessionList = [...grouped.entries()].map(([sessionId, sets]) => {
    const top = bestSet(sets.map((set) => ({ ...set, weightLb: num(set.weight_lb), reps: num(set.reps) })));
    const date = civilDate(sets[0].started_at);
    return {
      sessionId,
      date,
      dateLabel: longCivil(date),
      workoutName: sets[0].workout_name,
      top,
      sets: sets.map((set) => ({
        label: exercise.measure === "cardio"
          ? set.duration_sec != null
            ? `${Math.round(Number(set.duration_sec) / 60)} min`
            : "Cardio"
          : formatPerformance(num(set.weight_lb), num(set.reps), exercise.measure, set.per_side),
        isPr: set.is_pr,
      })),
    };
  });
  const recent = sessionList.slice(-16).reverse();
  const loaded = logged.some((row) => (num(row.weight_lb) ?? 0) > 0);
  const series = sessionList.slice(-16).map((session) => {
    const value = loaded ? (session.top?.weightLb ?? 0) : (session.top?.reps ?? 0);
    return {
      date: session.date,
      value,
      label: session.top ? formatPerformance(session.top.weightLb, session.top.reps, exercise.measure, perSide) : "—",
    };
  });
  const best = bestSet(logged.map((row) => ({ weightLb: num(row.weight_lb), reps: num(row.reps), logged_at: row.logged_at })));
  const bestRow = best
    ? logged.find((row) => num(row.weight_lb) === best.weightLb && num(row.reps) === best.reps)
    : undefined;
  const e1 = best && (best.weightLb ?? 0) > 0 && best.reps ? Math.round(best.weightLb! * (best.reps <= 1 ? 1 : 1 + best.reps / 30)) : null;
  return {
    id: exercise.id,
    name: exercise.name,
    measure: exercise.measure,
    best: best
      ? {
          label: formatPerformance(best.weightLb, best.reps, exercise.measure, perSide),
          e1rm: e1,
          dateLabel: bestRow ? longCivil(civilDate(bestRow.logged_at)) : "",
        }
      : null,
    chartLabel: loaded ? "Top set (lb)" : "Top set (reps)",
    series,
    sessions: recent,
  };
}

function mealInput(body: Record<string, unknown>) {
  return {
    name: cleanText(body.name, "Name", 80),
    calories: readNumber(body.calories, "Calories"),
    protein: readNumber(body.protein, "Protein", 1000),
    carbs: readNumber(body.carbs, "Carbs", 1500),
    fat: readNumber(body.fat, "Fat", 500),
    note: cleanText(typeof body.note === "string" ? body.note : "", "Note", 2000, false) || null,
    photo: cleanThumb(body.photo),
    date: readDate(body.date),
    time: readTime(body.time),
  };
}

export async function foodDay(dateInput: unknown): Promise<FoodDayDTO> {
  const date = dateInput == null || dateInput === "" ? civilDate(new Date()) : readDate(dateInput);
  const now = new Date();
  const meals = await mealsOn(date);
  const favorites = await rows<{
    id: string;
    name: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    note: string | null;
  }>(pool, "SELECT id, name, calories, protein, carbs, fat, note FROM favorites ORDER BY last_used_at DESC, name");
  const favoriteDTOs: FavoriteDTO[] = favorites.map((favorite) => ({
    id: favorite.id,
    name: favorite.name,
    calories: Number(favorite.calories),
    protein: Number(favorite.protein),
    carbs: Number(favorite.carbs),
    fat: Number(favorite.fat),
    note: favorite.note,
  }));
  return {
    date,
    today: civilDate(now),
    nowTime: timeValue(now),
    meals,
    favorites: favoriteDTOs,
    aiConfigured: aiConfigured(),
  };
}

export async function createMeal(body: Record<string, unknown>): Promise<MealDTO> {
  const meal = mealInput(body);
  const id = randomUUID();
  const loggedAt = wallTimeToUtc(meal.date, meal.time);
  await pool.query(
    `INSERT INTO meals (id, logged_at, name, calories, protein, carbs, fat, note, photo, sample)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false)`,
    [id, loggedAt, meal.name, meal.calories, meal.protein, meal.carbs, meal.fat, meal.note, meal.photo],
  );
  const saved = await rows<MealRow>(pool, "SELECT * FROM meals WHERE id = $1", [id]);
  return mealDTO(saved[0]);
}

export async function updateMeal(id: string, body: Record<string, unknown>): Promise<MealDTO> {
  const meal = mealInput(body);
  const loggedAt = wallTimeToUtc(meal.date, meal.time);
  const result = await pool.query(
    `UPDATE meals
     SET logged_at = $1, name = $2, calories = $3, protein = $4, carbs = $5, fat = $6, note = $7, photo = $8
     WHERE id = $9`,
    [loggedAt, meal.name, meal.calories, meal.protein, meal.carbs, meal.fat, meal.note, meal.photo, id],
  );
  if (result.rowCount === 0) throw new HttpError(404, "Meal not found");
  const saved = await rows<MealRow>(pool, "SELECT * FROM meals WHERE id = $1", [id]);
  return mealDTO(saved[0]);
}

export async function deleteMeal(id: string): Promise<void> {
  const result = await pool.query("DELETE FROM meals WHERE id = $1", [id]);
  if (result.rowCount === 0) throw new HttpError(404, "Meal not found");
}

export async function saveFavorite(body: Record<string, unknown>): Promise<FavoriteDTO> {
  const name = cleanText(body.name, "Name", 80);
  const calories = readNumber(body.calories, "Calories");
  const protein = readNumber(body.protein, "Protein", 1000);
  const carbs = readNumber(body.carbs, "Carbs", 1500);
  const fat = readNumber(body.fat, "Fat", 500);
  const note = cleanText(typeof body.note === "string" ? body.note : "", "Note", 2000, false) || null;
  const existing = await rows<{ id: string }>(pool, "SELECT id FROM favorites WHERE lower(name) = lower($1) LIMIT 1", [name]);
  const id = existing[0]?.id ?? randomUUID();
  if (existing[0]) {
    await pool.query(
      "UPDATE favorites SET name = $1, calories = $2, protein = $3, carbs = $4, fat = $5, note = $6, last_used_at = now() WHERE id = $7",
      [name, calories, protein, carbs, fat, note, id],
    );
  } else {
    await pool.query(
      "INSERT INTO favorites (id, name, calories, protein, carbs, fat, note) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, name, calories, protein, carbs, fat, note],
    );
  }
  return { id, name, calories, protein, carbs, fat, note };
}

export async function logFavorite(id: string, body: Record<string, unknown>): Promise<MealDTO> {
  const date = readDate(body.date);
  const time = readTime(body.time);
  const favorite = await rows<{
    name: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    note: string | null;
  }>(pool, "SELECT name, calories, protein, carbs, fat, note FROM favorites WHERE id = $1", [id]);
  if (!favorite[0]) throw new HttpError(404, "Favorite not found");
  const mealId = randomUUID();
  await pool.query(
    `INSERT INTO meals (id, logged_at, name, calories, protein, carbs, fat, note, sample)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)`,
    [
      mealId,
      wallTimeToUtc(date, time),
      favorite[0].name,
      favorite[0].calories,
      favorite[0].protein,
      favorite[0].carbs,
      favorite[0].fat,
      favorite[0].note,
    ],
  );
  await pool.query("UPDATE favorites SET last_used_at = now() WHERE id = $1", [id]);
  const saved = await rows<MealRow>(pool, "SELECT * FROM meals WHERE id = $1", [mealId]);
  return mealDTO(saved[0]);
}

export async function deleteFavorite(id: string): Promise<void> {
  const result = await pool.query("DELETE FROM favorites WHERE id = $1", [id]);
  if (result.rowCount === 0) throw new HttpError(404, "Favorite not found");
}

export async function getWeights(): Promise<WeightDTO> {
  const today = civilDate(new Date());
  const settings = await getSettings();
  const found = await rows<{ weighed_on: string; weight_lb: number }>(
    pool,
    "SELECT weighed_on, weight_lb FROM weights WHERE weighed_on >= $1 ORDER BY weighed_on",
    [addDays(today, -120)],
  );
  const entries = found.map((row) => ({ date: dateOnly(row.weighed_on), weightLb: Number(row.weight_lb) }));
  const average = sevenDayAverage(entries, today);
  const change = averageChange(entries, today);
  const start = addDays(today, -27);
  const points = Array.from({ length: 28 }, (_, index) => {
    const date = addDays(start, index);
    const weighIn = entries.find((entry) => entry.date === date);
    const rolling = sevenDayAverage(entries, date);
    return {
      date,
      weightLb: weighIn ? round1(weighIn.weightLb) : null,
      average: rolling ? round1(rolling.average) : null,
    };
  });
  return {
    target: settings.weightLb,
    average: average ? round1(average.average) : null,
    count: average?.count ?? 0,
    change: change == null ? null : round1(change),
    hint: weightHint(change),
    today: entries.find((entry) => entry.date === today)?.weightLb ?? null,
    points,
  };
}

export async function saveWeight(body: Record<string, unknown>): Promise<WeightDTO> {
  const today = civilDate(new Date());
  const date = body.date == null || body.date === "" ? today : readDate(body.date);
  const weight = readNumber(body.weightLb, "Weight", 600);
  if (weight < 50) throw new HttpError(400, "Weight looks off");
  const at = date === today ? new Date() : wallTimeToUtc(date, "12:00");
  await pool.query(
    `INSERT INTO weights (id, weighed_on, weight_lb, weighed_at, sample)
     VALUES ($1, $2, $3, $4, false)
     ON CONFLICT (weighed_on) DO UPDATE SET weight_lb = EXCLUDED.weight_lb, weighed_at = EXCLUDED.weighed_at, sample = false`,
    [randomUUID(), date, weight, at],
  );
  return getWeights();
}

export async function coachReview(from: string, to: string) {
  if (from > to) throw new HttpError(400, "The start date is after the end date");
  const dates = eachDate(from, to);
  if (dates.length > 120) throw new HttpError(400, "Date range is limited to 120 days");
  const settings = await getSettings();
  const meals = await rows<MealRow>(
    pool,
    `SELECT id, name, logged_at, calories, protein, carbs, fat, note, NULL::text AS photo
     FROM meals
     WHERE (logged_at AT TIME ZONE 'America/Boise')::date BETWEEN $1::date AND $2::date
     ORDER BY logged_at`,
    [from, to],
  );
  const weighIns = await rows<{ weighed_on: string; weight_lb: number }>(
    pool,
    "SELECT weighed_on, weight_lb FROM weights WHERE weighed_on BETWEEN $1::date AND $2::date ORDER BY weighed_on",
    [from, to],
  );
  const sessions = await rows<{ id: string; name: string; started_at: Date; completed_at: Date | null }>(
    pool,
    `SELECT id, name, started_at, completed_at FROM sessions
     WHERE (started_at AT TIME ZONE 'America/Boise')::date BETWEEN $1::date AND $2::date
     ORDER BY started_at`,
    [from, to],
  );
  const sessionIds = sessions.map((session) => session.id);
  const exercises = sessionIds.length
    ? await rows<{
        id: string;
        session_id: string;
        name: string;
        measure: string;
        per_side: boolean;
        is_cardio: boolean;
        sort_order: number;
      }>(
        pool,
        "SELECT id, session_id, name, measure, per_side, is_cardio, sort_order FROM session_exercises WHERE session_id = ANY($1::uuid[]) ORDER BY sort_order",
        [sessionIds],
      )
    : [];
  const sxIds = exercises.map((exercise) => exercise.id);
  const sets = sxIds.length
    ? await rows<{
        session_exercise_id: string;
        weight_lb: number | null;
        reps: number | null;
        duration_sec: number | null;
        is_pr: boolean;
        pr_kind: string | null;
        note: string | null;
        logged_at: Date;
        set_index: number;
      }>(
        pool,
        "SELECT session_exercise_id, weight_lb, reps, duration_sec, is_pr, pr_kind, note, logged_at, set_index FROM sets WHERE session_exercise_id = ANY($1::uuid[]) AND logged_at IS NOT NULL ORDER BY set_index",
        [sxIds],
      )
    : [];
  const prs = sets
    .filter((set) => set.is_pr)
    .map((set) => {
      const exercise = exercises.find((item) => item.id === set.session_exercise_id);
      return {
        date: civilDate(set.logged_at),
        exercise: exercise?.name ?? "",
        weightLb: num(set.weight_lb),
        reps: num(set.reps),
        kind: set.pr_kind,
      };
    });
  return {
    timezone: "America/Boise" as const,
    from,
    to,
    targets: targetsOf(settings),
    days: dates.map((date) => {
      const dayMeals = meals.filter((meal) => civilDate(meal.logged_at) === date).map((meal) => mealDTO(meal, false));
      const daySessions = sessions.filter((session) => civilDate(session.started_at) === date);
      return {
        date,
        meals: dayMeals.map(({ photo: _photo, timeLabel: _time, date: _date, ...meal }) => meal),
        totals: dailyTotals(dayMeals),
        weightLb: num(weighIns.find((row) => dateOnly(row.weighed_on) === date)?.weight_lb) ,
        workouts: daySessions.map((session) => ({
          id: session.id,
          name: session.name,
          startedAt: session.started_at.toISOString(),
          completedAt: stamp(session.completed_at),
          exercises: exercises
            .filter((exercise) => exercise.session_id === session.id)
            .map((exercise) => ({
              name: exercise.name,
              measure: exercise.measure,
              perSide: exercise.per_side,
              isCardio: exercise.is_cardio,
              sets: sets
                .filter((set) => set.session_exercise_id === exercise.id)
                .map((set) => ({
                  weightLb: num(set.weight_lb),
                  reps: num(set.reps),
                  durationSec: set.duration_sec == null ? null : Number(set.duration_sec),
                  isPr: set.is_pr,
                  prKind: set.pr_kind,
                  note: set.note,
                })),
            })),
        })),
      };
    }),
    prs,
    weights: weighIns.map((row) => ({ date: dateOnly(row.weighed_on), weightLb: Number(row.weight_lb) })),
  };
}
