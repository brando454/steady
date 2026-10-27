import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  cacheForCivilDay,
  foodDateAfterRollover,
  msUntilNextCivilMidnight,
  nextCivilMidnight,
  widgetRefreshAt,
  widgetTotalsForDay,
} from "../src/shared/dayRollover";
import { commitFocusedSetDraft, todayFocus } from "../src/shared/logic";
import { civilDate, wallTimeToUtc } from "../src/shared/time";

const lateMonday = wallTimeToUtc("2026-10-26", "23:59");
const tuesdayMidnight = wallTimeToUtc("2026-10-27", "00:00");
const tuesdayMorning = wallTimeToUtc("2026-10-27", "05:45");

test("Boise midnight, not UTC, is the day boundary", () => {
  assert.equal(civilDate(lateMonday), "2026-10-26");
  assert.equal(civilDate(new Date("2026-10-27T05:59:00.000Z")), "2026-10-26");
  assert.equal(civilDate(tuesdayMidnight), "2026-10-27");
  assert.equal(civilDate(new Date("2026-10-27T06:00:00.000Z")), "2026-10-27");
  assert.equal(civilDate(tuesdayMorning), "2026-10-27");
  assert.equal(nextCivilMidnight(lateMonday).toISOString(), tuesdayMidnight.toISOString());
  assert.ok(msUntilNextCivilMidnight(lateMonday) <= 60_000);
  const fullDay = msUntilNextCivilMidnight(tuesdayMidnight);
  assert.ok(fullDay > 23 * 60 * 60 * 1000 && fullDay <= 24 * 60 * 60 * 1000);
  assert.ok(msUntilNextCivilMidnight(tuesdayMorning) > 60 * 60 * 1000);
});

test("day rollover follows daylight saving midnights", () => {
  const beforeSpring = wallTimeToUtc("2026-03-07", "23:00");
  assert.equal(nextCivilMidnight(beforeSpring).toISOString(), wallTimeToUtc("2026-03-08", "00:00").toISOString());
  const beforeFall = wallTimeToUtc("2026-10-31", "23:00");
  assert.equal(nextCivilMidnight(beforeFall).toISOString(), wallTimeToUtc("2026-11-01", "00:00").toISOString());
});

test("a food day that was today rolls forward, and a picked day stays", () => {
  const rolled = foodDateAfterRollover("2026-10-26", true, tuesdayMorning);
  assert.deepEqual(rolled, { date: "2026-10-27", following: true, rolled: true });
  assert.deepEqual(foodDateAfterRollover("", true, tuesdayMorning), {
    date: "2026-10-27",
    following: true,
    rolled: false,
  });
  assert.deepEqual(foodDateAfterRollover("2026-10-26", true, lateMonday), {
    date: "2026-10-26",
    following: true,
    rolled: false,
  });
  assert.deepEqual(foodDateAfterRollover("2026-10-20", false, tuesdayMorning), {
    date: "2026-10-20",
    following: false,
    rolled: false,
  });
});

test("cached totals and a finished workout belong only to their civil day", () => {
  const yesterday = { date: "2026-10-26", calories: 450 };
  assert.equal(cacheForCivilDay(yesterday, "2026-10-27"), null);
  assert.equal(cacheForCivilDay(yesterday, "2026-10-26"), yesterday);
  assert.equal(cacheForCivilDay(null, "2026-10-27"), null);
  const days = [
    { dayId: "a", status: "done" as const },
    { dayId: "b", status: "todo" as const },
  ];
  assert.equal(todayFocus(days, [{ dayId: "a", sessionId: "s1" }])?.completedToday, true);
  assert.deepEqual(todayFocus(days, []), { dayId: "b", sessionId: null, completedToday: false });
});

test("widget totals reset at midnight and the timeline wakes then", () => {
  const snapshot = {
    date: "2026-10-26",
    caloriesEaten: 450,
    caloriesTarget: 3000,
    caloriesLeft: 2550,
    proteinEaten: 10,
    proteinTarget: 190,
    carbsEaten: 22,
    carbsTarget: 330,
    fatEaten: 15,
    fatTarget: 85,
  };
  assert.deepEqual(widgetTotalsForDay(snapshot, "2026-10-27"), {
    ...snapshot,
    date: "2026-10-27",
    caloriesEaten: 0,
    caloriesLeft: 3000,
    proteinEaten: 0,
    carbsEaten: 0,
    fatEaten: 0,
  });
  assert.equal(widgetTotalsForDay(snapshot, "2026-10-26"), snapshot);
  const nearMidnight = wallTimeToUtc("2026-10-26", "23:50");
  assert.equal(widgetRefreshAt(nearMidnight, 30 * 60 * 1000).toISOString(), tuesdayMidnight.toISOString());
  assert.equal(
    widgetRefreshAt(tuesdayMorning, 30 * 60 * 1000).toISOString(),
    new Date(tuesdayMorning.getTime() + 30 * 60 * 1000).toISOString(),
  );
});

test("meal and workout day queries use America/Boise", () => {
  const source = readFileSync(new URL("../src/server/data.ts", import.meta.url), "utf8");
  const boundaries = source.match(/\b(?:logged_at|completed_at|started_at)\b[^\n]{0,120}::date/g) ?? [];
  assert.ok(boundaries.length >= 5);
  for (const boundary of boundaries) {
    assert.match(boundary, /AT TIME ZONE 'America\/Boise'/);
  }
});

test("logging a set uses the number still sitting in the focused field", () => {
  const draft = { weight: "135", reps: "5", minutes: "", note: "" };
  assert.deepEqual(commitFocusedSetDraft(draft, { label: "weight", value: "185" }), {
    weight: "185",
    reps: "5",
    minutes: "",
    note: "",
  });
  assert.deepEqual(commitFocusedSetDraft(draft, { label: "reps", value: "8" }), {
    ...draft,
    reps: "8",
  });
  assert.deepEqual(commitFocusedSetDraft(draft, { label: "minutes", value: "12" }), {
    ...draft,
    minutes: "12",
  });
  assert.equal(commitFocusedSetDraft(draft, null), draft);
});
