import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertNightscoutNoteSafe,
  mealNoteText,
  nightscoutNotePayload,
} from "../src/shared/nightscoutNote";
import {
  glucoseOnLine,
  mealGlucoseLine,
  shouldPersistMealGlucose,
  storedMealGlucose,
  summarizeDayGlucose,
  summarizeMealGlucose,
} from "../src/shared/mealGlucose";
import { deleteNightscoutNote, deliverNightscoutNote } from "../src/server/nightscoutWrite";

const mealAt = Date.parse("2026-10-26T16:00:00.000Z");

function at(minutesFromMeal: number, mgdl: number) {
  return { at: mealAt + minutesFromMeal * 60_000, mgdl };
}

test("meal glucose reports the reading, peak, rise, and three-hour low", () => {
  const summary = summarizeMealGlucose({
    loggedAt: mealAt,
    now: mealAt + 4 * 60 * 60_000,
    entries: [
      at(-40, 80),
      at(-20, 100),
      at(-5, 110),
      at(30, 180),
      at(90, 130),
      at(120, 95),
      at(200, 70),
    ],
  });
  assert.equal(summary.inProgress, false);
  assert.equal(summary.unavailable, false);
  assert.equal(summary.atMgdl, 110);
  assert.equal(summary.peakMgdl, 180);
  assert.equal(summary.peakMinute, 30);
  assert.equal(summary.riseMgdl, 70);
  assert.equal(summary.lowAfterMgdl, 95);
  assert.deepEqual(
    summary.points.map((point) => point.minute),
    [-20, -5, 30, 90, 120],
  );
  assert.equal(shouldPersistMealGlucose(summary), true);
  assert.equal(storedMealGlucose(summary)?.peakMgdl, 180);
  assert.equal(storedMealGlucose({ ...summary, inProgress: true }), null);
  assert.equal(mealGlucoseLine(summary), "110 → 180 · +70");
});

test("an open meal window stays in progress and is not stored", () => {
  const summary = summarizeMealGlucose({
    loggedAt: mealAt,
    now: mealAt + 60 * 60_000,
    entries: [at(-5, 110), at(30, 180), at(90, 130)],
  });
  assert.equal(summary.inProgress, true);
  assert.equal(summary.peakMgdl, 180);
  assert.equal(summary.lowAfterMgdl, 180);
  assert.equal(summary.points.some((point) => point.minute === 90), false);
  assert.equal(shouldPersistMealGlucose(summary), false);
  assert.equal(mealGlucoseLine(summary), "110 → 180 · +70 · in progress");
});

test("the day graph places a meal marker on the line", () => {
  const start = Date.parse("2026-10-26T06:00:00.000Z");
  const meal = start + 8 * 60 * 60_000;
  const day = summarizeDayGlucose({
    startMs: start,
    now: start + 12 * 60 * 60_000,
    entries: [
      { at: meal - 5 * 60_000, mgdl: 100 },
      { at: meal + 5 * 60_000, mgdl: 140 },
    ],
    meals: [{ id: "m1", name: "Chicken bowl", at: meal, calories: 450, protein: 10, carbs: 22, fat: 15 }],
    workouts: [{ id: "w1", name: "Day A", at: meal + 60 * 60_000 }],
  });
  assert.equal(day.unavailable, false);
  assert.equal(day.markers[0]?.kind, "meal");
  assert.equal(day.markers[0]?.mgdl, 120);
  assert.equal(day.markers[0]?.name, "Chicken bowl");
  assert.equal(day.markers[1]?.kind, "workout");
  assert.equal(glucoseOnLine(day.points, day.markers[0]?.minute ?? 0), 120);
});

test("the Nightscout note payload is a note string and nothing else", () => {
  const payload = nightscoutNotePayload({
    name: "Chicken bowl",
    calories: 449.6,
    protein: 10.4,
    carbs: 22.2,
    fat: 14.6,
    createdAt: "2026-10-26T18:30:00.000Z",
  });
  assert.equal(mealNoteText({ name: "Chicken bowl", calories: 450, protein: 10, carbs: 22, fat: 15 }), payload.notes);
  assert.deepEqual(payload, {
    eventType: "Note",
    created_at: "2026-10-26T18:30:00.000Z",
    enteredBy: "Steady",
    notes: "Chicken bowl · 22C 10P 15F · 450 cal",
  });
  assert.deepEqual(Object.keys(payload).sort(), ["created_at", "enteredBy", "eventType", "notes"]);
  for (const key of ["carbs", "protein", "fat", "insulin", "absorptionTime"]) {
    assert.equal(Object.hasOwn(payload, key), false);
  }
  assert.throws(() => assertNightscoutNoteSafe({ ...payload, carbs: 22 }));
  assert.throws(() => assertNightscoutNoteSafe({ ...payload, insulin: "1" }));
  assert.throws(() => assertNightscoutNoteSafe({ ...payload, absorptionTime: "60" }));
  assert.throws(() => assertNightscoutNoteSafe({ ...payload, protein: 10 }));
  assert.throws(() => assertNightscoutNoteSafe({ ...payload, fat: 15 }));
  assert.throws(() => assertNightscoutNoteSafe({ ...payload, notes: 22 }));
  const withId = nightscoutNotePayload({
    name: "Chicken bowl",
    calories: 450,
    protein: 10,
    carbs: 22,
    fat: 15,
    createdAt: "2026-10-26T18:30:00.000Z",
    id: "abc123",
  });
  assert.deepEqual(Object.keys(withId).sort(), ["_id", "created_at", "enteredBy", "eventType", "notes"]);
});

test("the note writer posts only that payload and uses the write token", async () => {
  const calls: { method: string; url: string; body?: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if ((init?.method ?? "GET") === "GET" || init?.method === "DELETE") {
      return new Response(init?.method === "DELETE" ? "" : "[]", { status: 200 });
    }
    const sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ _id: "abc123", ...sent }), { status: 200 });
  };
  const result = await deliverNightscoutNote({
    meal: {
      name: "Chicken bowl",
      calories: 450,
      protein: 10,
      carbs: 22,
      fat: 15,
      createdAt: "2026-10-26T18:30:00.000Z",
    },
    fetchImpl,
    base: "https://ns.example/api/v1",
    token: "write-token",
  });
  assert.equal(result.ok && result.id, "abc123");
  const post = calls.find((call) => call.method === "POST");
  assert.ok(post);
  assert.equal(new URL(post.url).searchParams.get("token"), "write-token");
  assert.equal(post.url.includes("read-token"), false);
  const body = JSON.parse(post.body ?? "{}") as Record<string, unknown>;
  assert.deepEqual(body, {
    eventType: "Note",
    created_at: "2026-10-26T18:30:00.000Z",
    enteredBy: "Steady",
    notes: "Chicken bowl · 22C 10P 15F · 450 cal",
  });
  for (const key of ["carbs", "protein", "fat", "insulin", "absorptionTime"]) {
    assert.equal(Object.hasOwn(body, key), false);
  }

  calls.length = 0;
  const updated = await deliverNightscoutNote({
    meal: {
      name: "Chicken bowl",
      calories: 450,
      protein: 12,
      carbs: 22,
      fat: 15,
      createdAt: "2026-10-26T18:30:00.000Z",
    },
    existingId: "abc123",
    fetchImpl,
    base: "https://ns.example",
    token: "write-token",
  });
  assert.equal(updated.ok && updated.id, "abc123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "PUT");
  assert.match(calls[0]?.url ?? "", /\/api\/v1\/treatments\/abc123/);
  const putBody = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
  assert.equal(putBody.notes, "Chicken bowl · 22C 12P 15F · 450 cal");
  assert.equal(putBody._id, "abc123");
  assert.deepEqual(Object.keys(putBody).sort(), ["_id", "created_at", "enteredBy", "eventType", "notes"]);

  calls.length = 0;
  const removed = await deleteNightscoutNote({
    id: "abc123",
    fetchImpl,
    base: "https://ns.example",
    token: "write-token",
  });
  assert.equal(removed.ok, true);
  assert.equal(calls[0]?.method, "DELETE");
  assert.equal(calls[0]?.body, undefined);

  const source = readFileSync(new URL("../src/server/nightscoutWrite.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /["']carbs["']\s*:/);
  assert.doesNotMatch(source, /["']protein["']\s*:/);
  assert.doesNotMatch(source, /["']fat["']\s*:/);
  assert.doesNotMatch(source, /["']insulin["']\s*:/);
  assert.doesNotMatch(source, /absorptionTime/);
  assert.match(source, /assertNightscoutNoteSafe/);
  assert.match(source, /NIGHTSCOUT_WRITE_TOKEN/);
  assert.doesNotMatch(source, /NIGHTSCOUT_TOKEN/);
});
