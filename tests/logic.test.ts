import assert from "node:assert/strict";
import test from "node:test";
import { chartScale, formatPerformance } from "../src/shared/format";
import {
  annotatePrs,
  averageChange,
  dailyTotals,
  detectPr,
  greetingFor,
  macrosLeft,
  rampForDate,
  sevenDayAverage,
  dayDoneLine,
  shouldCelebrate,
  suggestedDayId,
  usualActionLabel,
  todayFocus,
  weekDayStatuses,
  weightHint,
  widgetToday,
} from "../src/shared/logic";
import { presentedWidgetToken, widgetTokenOk } from "../src/server/auth";
import { DAYS, DEFAULT_RAMP, EXERCISES, SUBSTITUTES } from "../src/shared/program";
import { civilDate, wallTimeToUtc, weekdayShort, weekStartCivil } from "../src/shared/time";

test("daily totals and remaining macros", () => {
  const totals = dailyTotals([
    { calories: 680, protein: 38, carbs: 72, fat: 24 },
    { calories: 320.5, protein: 42, carbs: 28, fat: 6 },
  ]);
  assert.deepEqual(totals, { calories: 1000.5, protein: 80, carbs: 100, fat: 30 });
  assert.deepEqual(macrosLeft(totals, { calories: 3000, protein: 190, carbs: 330, fat: 85 }), {
    calories: 1999.5,
    protein: 110,
    carbs: 230,
    fat: 55,
  });
  assert.deepEqual(dailyTotals([]), { calories: 0, protein: 0, carbs: 0, fat: 0 });
});

test("widget payload uses today totals, targets, and calories left", () => {
  const totals = dailyTotals([
    { calories: 680, protein: 38, carbs: 72, fat: 24 },
    { calories: 320, protein: 42, carbs: 28, fat: 6 },
  ]);
  const targets = { calories: 3000, protein: 190, carbs: 330, fat: 85 };
  assert.deepEqual(widgetToday("2026-10-25", "2026-10-25T16:00:00.000Z", totals, targets), {
    date: "2026-10-25",
    updatedAt: "2026-10-25T16:00:00.000Z",
    calories: { eaten: 1000, target: 3000, left: 2000 },
    protein: { eaten: 80, target: 190 },
    carbs: { eaten: 100, target: 330 },
    fat: { eaten: 30, target: 85 },
  });
});

test("widget token accepts a bearer header or a query token", () => {
  assert.equal(presentedWidgetToken("Bearer secret", undefined), "secret");
  assert.equal(presentedWidgetToken("bearer secret", "other"), "secret");
  assert.equal(presentedWidgetToken("Bearer ", "from-query"), "from-query");
  assert.equal(presentedWidgetToken(undefined, " from-query "), "from-query");
  assert.equal(presentedWidgetToken(undefined, ["from-query"]), "from-query");
  assert.equal(presentedWidgetToken(undefined, undefined), "");
  assert.equal(widgetTokenOk("secret", "secret"), true);
  assert.equal(widgetTokenOk("secret", " secret "), true);
  assert.equal(widgetTokenOk("nope", "secret"), false);
  assert.equal(widgetTokenOk("", "secret"), false);
  assert.equal(widgetTokenOk("secret", ""), false);
  assert.equal(widgetTokenOk("secret", undefined), false);
});

test("PR detection uses weight at those reps or estimated 1RM", () => {
  assert.deepEqual(detectPr([], { weightLb: 225, reps: 5 }), { isPr: false, kind: null });
  assert.deepEqual(detectPr([{ weightLb: 225, reps: 5 }], { weightLb: 225, reps: 5 }), {
    isPr: false,
    kind: null,
  });
  assert.deepEqual(detectPr([{ weightLb: 225, reps: 5 }], { weightLb: 230, reps: 5 }), {
    isPr: true,
    kind: "weight",
  });
  assert.deepEqual(detectPr([{ weightLb: 225, reps: 5 }], { weightLb: 225, reps: 6 }), {
    isPr: true,
    kind: "e1rm",
  });
  assert.deepEqual(detectPr([{ weightLb: 225, reps: 5 }], { weightLb: 185, reps: 10 }), {
    isPr: false,
    kind: null,
  });
  assert.equal(detectPr([{ weightLb: 210, reps: 5 }], { weightLb: 205, reps: 8 }).isPr, true);

  const sequence = annotatePrs([
    { id: "1", weightLb: 200, reps: 5 },
    { id: "2", weightLb: 200, reps: 5 },
    { id: "3", weightLb: 210, reps: 5 },
    { id: "4", weightLb: 0, reps: 12 },
  ]);
  assert.deepEqual(
    sequence.map((set) => set.isPr),
    [false, false, true, false],
  );
  assert.equal(sequence[2].kind, "weight");
});

test("bodyweight progress is a PR only when the exercise stays unloaded", () => {
  assert.equal(detectPr([{ weightLb: 0, reps: 10 }], { weightLb: 0, reps: 12 }).isPr, true);
  assert.equal(detectPr([{ weightLb: 0, reps: 12 }], { weightLb: 0, reps: 12 }).isPr, false);
  assert.equal(detectPr([{ weightLb: 25, reps: 8 }], { weightLb: 0, reps: 15 }).isPr, false);
});

test("the training week resets every Monday and old unfinished days do not pile up", () => {
  assert.equal(weekdayShort("2026-10-24"), "Sat");
  assert.equal(weekdayShort("2026-10-26"), "Mon");
  assert.equal(weekStartCivil("2026-10-24"), "2026-10-19");
  assert.equal(weekStartCivil("2026-10-26"), "2026-10-26");

  const days = ["a", "b", "c", "d", "e"];
  const statuses = weekDayStatuses(
    days,
    [
      { dayId: "a", weekStart: "2026-10-12", completed: false },
      { dayId: "e", weekStart: "2026-10-12", completed: false },
      { dayId: "a", weekStart: "2026-10-19", completed: true },
      { dayId: "b", weekStart: "2026-10-19", completed: true },
    ],
    "2026-10-19",
  );
  assert.deepEqual(
    statuses.map((status) => status.status),
    ["done", "done", "todo", "todo", "todo"],
  );
  assert.equal(suggestedDayId(statuses), "c");

  const resumed = weekDayStatuses(
    days,
    [
      { dayId: "a", weekStart: "2026-10-19", completed: true },
      { dayId: "a", weekStart: "2026-10-19", completed: false },
    ],
    "2026-10-19",
  );
  assert.equal(resumed[0].status, "in_progress");
  assert.equal(suggestedDayId(resumed), "a");
});

test("today keeps the workout finished on the Boise day, then moves on tomorrow", () => {
  const statuses = [
    { dayId: "push", status: "done" as const },
    { dayId: "pull", status: "todo" as const },
    { dayId: "legs", status: "todo" as const },
  ];
  const finished = [{ dayId: "push", sessionId: "session-1" }];
  const late = new Date("2026-10-27T05:30:00.000Z");
  const nextMorning = new Date("2026-10-27T06:30:00.000Z");
  assert.equal(civilDate(late), "2026-10-26");
  assert.equal(civilDate(nextMorning), "2026-10-27");

  assert.deepEqual(todayFocus(statuses, finished), {
    dayId: "push",
    sessionId: "session-1",
    completedToday: true,
  });
  assert.deepEqual(todayFocus(statuses, []), {
    dayId: "pull",
    sessionId: null,
    completedToday: false,
  });
  assert.deepEqual(
    todayFocus(
      [
        { dayId: "push", status: "done" },
        { dayId: "pull", status: "in_progress" },
      ],
      finished,
    ),
    { dayId: "pull", sessionId: null, completedToday: false },
  );
  assert.deepEqual(
    todayFocus(
      [
        { dayId: "push", status: "done" },
        { dayId: "pull", status: "done" },
      ],
      [
        { dayId: "pull", sessionId: "later" },
        { dayId: "push", sessionId: "earlier" },
      ],
    ),
    { dayId: "pull", sessionId: "later", completedToday: true },
  );
  assert.equal(
    todayFocus(
      [
        { dayId: "push", status: "done" },
        { dayId: "pull", status: "done" },
      ],
      [],
    ),
    null,
  );
  assert.equal(dayDoneLine(12, 2), "12 sets · 2 new PRs");
  assert.equal(dayDoneLine(1, 1), "1 set · 1 new PR");
  assert.equal(dayDoneLine(8, 0), "8 sets");
  assert.equal(shouldCelebrate(false, false), true);
  assert.equal(shouldCelebrate(true, false), false);
  assert.equal(shouldCelebrate(false, true), false);
});

test("a filled usual updates the saved meal only as an explicit rename of the button", () => {
  const loaded = { name: "Chicken rice bowl", calories: 740, protein: 58, carbs: 70, fat: 22, note: "About 200 g chicken" };
  const same = { name: "Chicken rice bowl", calories: 740, protein: 58, carbs: 70, fat: 22, note: "About 200 g chicken" };
  assert.equal(usualActionLabel(null, same), "Save as usual");
  assert.equal(usualActionLabel(loaded, same), "Save as usual");
  assert.equal(usualActionLabel(loaded, { ...same, calories: 700 }), "Update usual");
  assert.equal(usualActionLabel(loaded, { ...same, note: "" }), "Update usual");
  assert.equal(usualActionLabel({ ...loaded, note: null }, { ...same, note: "" }), "Save as usual");
  assert.equal(usualActionLabel(loaded, { ...same, name: "Bigger bowl" }), "Save as usual");
});

test("Boise civil dates pick the Monday week across the UTC offset", () => {
  const before = new Date("2026-10-26T05:59:00.000Z");
  assert.equal(civilDate(before), "2026-10-25");
  assert.equal(weekStartCivil(civilDate(before)), "2026-10-19");
  const after = new Date("2026-10-26T06:30:00.000Z");
  assert.equal(civilDate(after), "2026-10-26");
  assert.equal(weekStartCivil(civilDate(after)), "2026-10-26");
  assert.equal(wallTimeToUtc("2026-10-26", "05:35").toISOString(), "2026-10-26T11:35:00.000Z");
  assert.equal(wallTimeToUtc("2026-10-24", "12:00").toISOString(), "2026-10-24T18:00:00.000Z");
  assert.equal(wallTimeToUtc("2026-11-02", "12:00").toISOString(), "2026-11-02T19:00:00.000Z");
  assert.equal(wallTimeToUtc("2026-12-01", "00:30").toISOString(), "2026-12-01T07:30:00.000Z");
});

test("7-day average, weekly change, and the calorie hint", () => {
  const entries = [
    { date: "2026-10-17", weightLb: 300 },
    { date: "2026-10-18", weightLb: 214 },
    { date: "2026-10-19", weightLb: 216 },
    { date: "2026-10-24", weightLb: 215 },
  ];
  const window = sevenDayAverage(entries, "2026-10-24");
  assert.equal(window?.count, 3);
  assert.equal(window?.average, 215);
  assert.equal(sevenDayAverage([], "2026-10-24"), null);

  const series = [
    ...[214, 214, 214, 214, 214, 214, 214].map((weightLb, index) => ({
      date: `2026-10-${String(11 + index).padStart(2, "0")}`,
      weightLb,
    })),
    ...[215, 215, 215, 215, 215, 215, 215].map((weightLb, index) => ({
      date: `2026-10-${String(18 + index).padStart(2, "0")}`,
      weightLb,
    })),
  ];
  assert.equal(averageChange(series, "2026-10-24"), 1);
  assert.equal(weightHint(0.5).tone, "steady");
  assert.equal(weightHint(0.2).text, "Holding steady. Keep calories where they are.");
  assert.match(weightHint(0.51).text, /150 kcal/);
  assert.equal(weightHint(0.51).tone, "up");
  assert.equal(weightHint(-0.6).tone, "down");
  assert.equal(weightHint(null).tone, "wait");
});

test("surgery ramp note is 70% the week of Oct 26, then 85%, then gone", () => {
  assert.equal(rampForDate(DEFAULT_RAMP, "2026-10-24"), null);
  assert.equal(rampForDate(DEFAULT_RAMP, "2026-10-26")?.percent, 70);
  assert.equal(rampForDate(DEFAULT_RAMP, "2026-11-01")?.percent, 70);
  assert.match(rampForDate(DEFAULT_RAMP, "2026-10-28")?.note ?? "", /70%/);
  assert.equal(rampForDate(DEFAULT_RAMP, "2026-11-02")?.percent, 85);
  assert.equal(rampForDate(DEFAULT_RAMP, "2026-11-08")?.percent, 85);
  assert.equal(rampForDate(DEFAULT_RAMP, "2026-11-09"), null);
});

test("program slots point at real exercises and substitutes", () => {
  const ids = new Set(EXERCISES.map((exercise) => exercise.id));
  for (const day of DAYS) {
    assert.ok(day.slots.length >= 4, day.name);
    for (const slot of day.slots) assert.ok(ids.has(slot.exerciseId), slot.exerciseId);
  }
  for (const [exerciseId, subs] of Object.entries(SUBSTITUTES)) {
    assert.ok(ids.has(exerciseId), exerciseId);
    assert.ok(subs.length >= 3 && subs.length <= 4, exerciseId);
    for (const sub of subs) assert.ok(ids.has(sub), sub);
  }
});

test("greeting follows the hour and set labels stay readable", () => {
  assert.equal(greetingFor(5, "Brandon"), "Good morning, Brandon");
  assert.equal(greetingFor(12, "Brandon"), "Good afternoon, Brandon");
  assert.equal(greetingFor(17, "Brandon"), "Good evening, Brandon");
  assert.equal(formatPerformance(225, 5, "reps", false), "225 lb × 5");
  assert.equal(formatPerformance(50, 8, "reps", true), "50 lb × 8 / side");
  assert.equal(formatPerformance(70, 40, "meters", false), "70 lb × 40 m");
  assert.equal(formatPerformance(0, 12, "reps", false), "12 reps");
});

test("weight chart keeps a minimum range and distinct ticks", () => {
  const flat = chartScale([215, 215]);
  assert.deepEqual(flat.ticks, [212, 214, 216, 218]);
  assert.ok(flat.yMin <= 212 && flat.yMax >= 218);
  assert.ok(flat.yMin < 215 && flat.yMax > 215);
  assert.equal(new Set(flat.ticks).size, flat.ticks.length);

  const wide = chartScale([200, 230]);
  assert.deepEqual(wide.ticks, [200, 210, 220, 230]);
  assert.ok(wide.yMin < 200 && wide.yMax > 230);
});
