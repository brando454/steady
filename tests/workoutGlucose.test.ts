import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  nightscoutRangeUrl,
  parseNightscoutEntries,
  readGlucoseRange,
} from "../src/server/nightscout";
import {
  glucoseBand,
  shouldPersistWorkoutGlucose,
  sparklinePaths,
  storedWorkoutGlucose,
  summarizeWorkoutGlucose,
  type WorkoutGlucose,
} from "../src/shared/workoutGlucose";

const start = Date.parse("2026-10-26T16:00:00.000Z");
const finish = start + 50 * 60_000;
const closed = finish + 3 * 60 * 60_000;

function at(minutesFromStart: number, mgdl: number) {
  return { at: start + minutesFromStart * 60_000, mgdl };
}

test("workout glucose summarizes the session and the two hours after", () => {
  const summary = summarizeWorkoutGlucose({
    startedAt: start,
    completedAt: finish,
    now: closed,
    entries: [
      at(-14, 110),
      at(-16, 90),
      at(20, 96),
      at(40, 140),
      at(50, 132),
      at(70, 101),
      at(160, 84),
      at(171, 70),
    ],
  });
  assert.equal(summary.inProgress, false);
  assert.equal(summary.unavailable, false);
  assert.equal(summary.startMgdl, 110);
  assert.equal(summary.endMgdl, 132);
  assert.equal(summary.averageMgdl, 123);
  assert.equal(summary.lowDuringMgdl, 96);
  assert.equal(summary.lowAfterMgdl, 84);
  assert.equal(summary.workoutMinutes, 50);
  assert.equal(summary.windowMinutes, 170);
  assert.deepEqual(
    summary.points.map((point) => point.mgdl),
    [96, 140, 132, 101, 84],
  );
  assert.equal(shouldPersistWorkoutGlucose(summary), true);
  assert.deepEqual(storedWorkoutGlucose(summary), summary);
});

test("an open two-hour window stays in progress and ignores future readings", () => {
  const summary = summarizeWorkoutGlucose({
    startedAt: start,
    completedAt: finish,
    now: finish + 30 * 60_000,
    entries: [at(10, 150), at(50, 140), at(70, 99), at(100, 80)],
  });
  assert.equal(summary.inProgress, true);
  assert.equal(summary.lowAfterMgdl, 99);
  assert.equal(summary.averageMgdl, 145);
  assert.deepEqual(
    summary.points.map((point) => point.minute),
    [10, 50, 70],
  );
  assert.equal(shouldPersistWorkoutGlucose(summary), false);
  assert.equal(storedWorkoutGlucose({ ...summary, unavailable: false }), null);
});

test("missing readings and gaps stay empty instead of invented numbers", () => {
  const summary = summarizeWorkoutGlucose({
    startedAt: start,
    completedAt: finish,
    now: closed,
    entries: [at(-20, 100), at(30, 130), at(30, 12), at(80, 600)],
  });
  assert.equal(summary.startMgdl, null);
  assert.equal(summary.endMgdl, null);
  assert.equal(summary.averageMgdl, 130);
  assert.equal(summary.lowDuringMgdl, 130);
  assert.equal(summary.lowAfterMgdl, null);
  assert.deepEqual(summary.points, [{ minute: 30, mgdl: 130 }]);

  const empty = summarizeWorkoutGlucose({ startedAt: start, completedAt: finish, now: closed, entries: [] });
  assert.equal(empty.startMgdl, null);
  assert.equal(empty.endMgdl, null);
  assert.equal(empty.averageMgdl, null);
  assert.equal(empty.lowDuringMgdl, null);
  assert.equal(empty.lowAfterMgdl, null);
  assert.deepEqual(empty.points, []);
  assert.equal(shouldPersistWorkoutGlucose(empty), true);

  const tie = summarizeWorkoutGlucose({
    startedAt: start,
    completedAt: finish,
    now: closed,
    entries: [at(-5, 121), at(5, 133)],
  });
  assert.equal(tie.startMgdl, 121);
});

test("glucose bands match the pill, and the sparkline breaks on a long gap", () => {
  assert.equal(glucoseBand(119), "low");
  assert.equal(glucoseBand(120), "ok");
  assert.equal(glucoseBand(180), "ok");
  assert.equal(glucoseBand(181), "high");
  assert.equal(glucoseBand(null), "ok");

  const groups = sparklinePaths([
    { minute: 0, mgdl: 120 },
    { minute: 12, mgdl: 130 },
    { minute: 25, mgdl: 90 },
    { minute: 30, mgdl: 88 },
  ]);
  assert.deepEqual(groups.map((group) => group.map((point) => point.minute)), [
    [0, 12],
    [25, 30],
  ]);
});

test("a stored snapshot must be a closed summary", () => {
  const good: WorkoutGlucose = {
    inProgress: false,
    unavailable: false,
    startMgdl: 118,
    endMgdl: null,
    averageMgdl: 120,
    lowDuringMgdl: 100,
    lowAfterMgdl: 84,
    workoutMinutes: 40,
    windowMinutes: 160,
    points: [{ minute: 0, mgdl: 118 }],
  };
  assert.deepEqual(storedWorkoutGlucose(good), good);
  assert.equal(storedWorkoutGlucose({ ...good, lowAfterMgdl: 10 }), null);
  assert.equal(storedWorkoutGlucose({ ...good, unavailable: true }), null);
  assert.equal(storedWorkoutGlucose(null), null);
  assert.equal(shouldPersistWorkoutGlucose({ ...good, unavailable: true }), false);
});

test("Nightscout history is a GET for the session window", async () => {
  const from = start - 15 * 60_000;
  const to = finish + 2 * 60 * 60_000;
  const url = nightscoutRangeUrl("https://example.test/api/v1", "secret-token", from, to);
  assert.equal(url.pathname, "/api/v1/entries.json");
  assert.equal(url.searchParams.get("count"), "1000");
  assert.equal(url.searchParams.get("token"), "secret-token");
  assert.equal(url.searchParams.get("find[date][$gte]"), String(from));
  assert.equal(url.searchParams.get("find[date][$lte]"), String(to));

  const source = readFileSync(new URL("../src/server/nightscout.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /method:\s*"POST"/);
  assert.doesNotMatch(source, /method:\s*"PUT"/);
  assert.doesNotMatch(source, /method:\s*"PATCH"/);
  assert.doesNotMatch(source, /method:\s*"DELETE"/);

  const parsed = parseNightscoutEntries([
    { type: "mbg", sgv: 140, date: start },
    { type: "sgv", sgv: 10, date: start },
    { type: "sgv", sgv: 128.4, date: start + 60_000 },
    { sgv: 130, date: start },
    { sgv: "nope", date: start },
    { message: "no" },
  ]);
  assert.deepEqual(parsed, [
    { at: start, mgdl: 130 },
    { at: start + 60_000, mgdl: 128 },
  ]);
  assert.equal(parseNightscoutEntries({ status: 500 }), null);

  const previousUrl = process.env.NIGHTSCOUT_URL;
  const previousToken = process.env.NIGHTSCOUT_TOKEN;
  try {
    delete process.env.NIGHTSCOUT_URL;
    delete process.env.NIGHTSCOUT_TOKEN;
    const missing = await readGlucoseRange(from, to, fetch);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason, "not_configured");

    process.env.NIGHTSCOUT_URL = "https://example.test";
    process.env.NIGHTSCOUT_TOKEN = "secret-token";
    let method = "";
    let href = "";
    const httpFail: typeof fetch = async (input, init) => {
      method = init?.method ?? "";
      href = String(input instanceof URL ? input.href : input);
      return new Response("no", { status: 401 });
    };
    const failed = await readGlucoseRange(from, to, httpFail);
    assert.equal(method, "GET");
    assert.match(href, /find(?:%5B|\[)date(?:%5D|\])/);
    assert.equal(href.includes("secret-token"), true);
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.reason, "http_401");

    const empty = await readGlucoseRange(from, to, async () => new Response("[]", { status: 200 }));
    assert.deepEqual(empty, { ok: true, entries: [] });

    const bad = await readGlucoseRange(from, to, async () => new Response("{}", { status: 200 }));
    assert.equal(bad.ok, false);

    const leaked = await readGlucoseRange(from, to, async () => {
      throw new Error("down https://example.test/api/v1/entries.json?token=secret-token");
    });
    assert.equal(leaked.ok, false);
    if (!leaked.ok) {
      assert.equal(leaked.reason, "network");
      assert.equal(leaked.detail?.includes("secret-token"), false);
    }
  } finally {
    if (previousUrl == null) delete process.env.NIGHTSCOUT_URL;
    else process.env.NIGHTSCOUT_URL = previousUrl;
    if (previousToken == null) delete process.env.NIGHTSCOUT_TOKEN;
    else process.env.NIGHTSCOUT_TOKEN = previousToken;
  }
});
