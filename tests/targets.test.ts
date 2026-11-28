import assert from "node:assert/strict";
import test from "node:test";
import { latestLoggedWeight, nextPlannedDay, prefillTarget } from "../src/shared/targets";

test("the next planned day skips finished days and keeps an open session", () => {
  const days = ["a", "b", "c"];
  assert.equal(nextPlannedDay(days, [
    { dayId: "a", status: "done" },
    { dayId: "b", status: "todo" },
    { dayId: "c", status: "todo" },
  ])?.dayId, "b");
  assert.equal(nextPlannedDay(days, [
    { dayId: "a", status: "in_progress" },
    { dayId: "b", status: "todo" },
  ])?.open, true);
  assert.equal(nextPlannedDay(days, days.map((dayId) => ({ dayId, status: "done" as const })))?.wrapped, true);
});

test("a new session prefills the latest logged weight and the program rep count", () => {
  const weight = latestLoggedWeight(
    [
      { exerciseId: "bench", loggedAt: 1, weightLb: 175 },
      { exerciseId: "bench", loggedAt: 2, weightLb: 185 },
    ],
    "bench",
  );
  assert.equal(weight, 185);
  const target = prefillTarget({
    isCardio: false,
    sets: 4,
    repCount: 5,
    repsLabel: "5",
    measure: "reps",
    perSide: false,
    latestWeightLb: weight,
    last: { weightLb: 185, reps: 5 },
  });
  assert.equal(target.targetSets, 4);
  assert.equal(target.targetWeightLb, 185);
  assert.equal(target.targetReps, 5);
  assert.equal(target.lastTime, "185 lb × 5");
  const cardio = prefillTarget({
    isCardio: true,
    sets: 1,
    repCount: 20,
    repsLabel: "20 min",
    measure: "cardio",
    perSide: false,
    latestWeightLb: 0,
    last: null,
  });
  assert.equal(cardio.targetWeightLb, null);
  assert.equal(cardio.targetReps, null);
  assert.equal(cardio.repsLabel, "20 min");
});
