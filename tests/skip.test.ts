import assert from "node:assert/strict";
import test from "node:test";
import { completedSetCount, liveLine, setIsOpen, targetPhrase, type LiveExercise } from "../src/shared/live";

const press: LiveExercise = {
  name: "Overhead press",
  skipped: false,
  isCardio: false,
  setsPlanned: 4,
  repsLabel: "6",
  measure: "reps",
  perSide: false,
  supersetGroup: null,
  supersetOrder: null,
  sortOrder: 0,
  sets: [
    { id: "s1", setIndex: 1, skipped: false, loggedAt: "2026-10-30T12:00:00Z", weightLb: 95, reps: 6 },
    { id: "s2", setIndex: 2, skipped: false, loggedAt: null, weightLb: 95, reps: 6 },
    { id: "s3", setIndex: 3, skipped: true, loggedAt: null, weightLb: 95, reps: 6 },
    { id: "s4", setIndex: 4, skipped: false, loggedAt: null, weightLb: null, reps: 6 },
  ],
};

test("the live line uses the next open set and skips skipped work", () => {
  const line = liveLine([press]);
  assert.equal(line?.headline, "Overhead press · Set 2 of 4 · 95 lb × 6");
  assert.equal(line?.detail, "Next: Overhead press 95 lb × 6");
  assert.equal(line?.shortName, "Overhead press");
  assert.equal(setIsOpen(press, press.sets[2]), false);
  assert.equal(completedSetCount([press]), 1);
});

test("a missing weight falls back to the rep target", () => {
  const open = { ...press, sets: [press.sets[3]] };
  const line = liveLine([open]);
  assert.equal(line?.headline, "Overhead press · Set 4 of 4 · 6");
  assert.equal(targetPhrase(null, null, "15", true), "15");
  assert.equal(targetPhrase(30, 12, "12", false), "30 × 12");
});

test("an edited draft replaces the prefilled weight", () => {
  const line = liveLine([press], { s2: { weight: "100", reps: "5", minutes: "" } });
  assert.equal(line?.headline, "Overhead press · Set 2 of 4 · 100 lb × 5");
});

test("a superset round names both movements and a skipped movement drops out", () => {
  const curl: LiveExercise = {
    name: "DB curl",
    skipped: false,
    isCardio: false,
    setsPlanned: 3,
    repsLabel: "12",
    measure: "reps",
    perSide: false,
    supersetGroup: "ss",
    supersetOrder: 1,
    sortOrder: 1,
    sets: [{ id: "c1", setIndex: 1, skipped: false, loggedAt: null, weightLb: 30, reps: 12 }],
  };
  const push: LiveExercise = {
    ...curl,
    name: "Pushdown",
    supersetOrder: 2,
    sortOrder: 2,
    sets: [{ id: "p1", setIndex: 1, skipped: false, loggedAt: null, weightLb: 50, reps: 12 }],
  };
  const together = liveLine([curl, push]);
  assert.equal(together?.headline, "Set 1 · A1 DB curl 30 × 12 · A2 Pushdown 50 × 12");
  assert.equal(together?.shortName, "Superset");
  const oneSide = liveLine([curl, { ...push, skipped: true }]);
  assert.equal(oneSide?.headline, "DB curl · Set 1 of 3 · 30 lb × 12");
  assert.equal(liveLine([{ ...curl, skipped: true }, { ...push, skipped: true }]), null);
});
