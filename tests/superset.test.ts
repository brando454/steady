import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DAYS, EXERCISES, SUBSTITUTES } from "../src/shared/program";
import { exerciseBlocks, programPreview, restSecondsForRound, supersetTitle } from "../src/shared/superset";

const names = new Map(EXERCISES.map((exercise) => [exercise.id, exercise.name]));

test("plan slots split combined lifts and leave alternatives alone", () => {
  for (const day of DAYS) {
    const groups = new Map<string, { exerciseId: string; order: number; sets: number }[]>();
    for (const slot of day.slots) {
      const name = names.get(slot.exerciseId) ?? slot.exerciseId;
      assert.equal(name.includes(" + "), false, `${day.id} still has a combined slot: ${name}`);
      if (!slot.supersetGroup) {
        assert.equal(slot.supersetOrder, undefined);
        continue;
      }
      const list = groups.get(slot.supersetGroup) ?? [];
      list.push({ exerciseId: slot.exerciseId, order: slot.supersetOrder ?? 0, sets: slot.sets });
      groups.set(slot.supersetGroup, list);
    }
    for (const [group, slots] of groups) {
      assert.deepEqual(slots.map((slot) => slot.order), [1, 2], group);
      assert.equal(slots[0].sets, slots[1].sets, group);
      assert.equal(new Set(slots.map((slot) => slot.exerciseId)).size, 2, group);
    }
  }
  const dayC = DAYS.find((day) => day.id === "c");
  assert.ok(dayC);
  const ids = dayC.slots.map((slot) => slot.exerciseId);
  assert.deepEqual(ids.filter((id) => id === "face-pull" || id === "lateral-raise" || id === "db-curl" || id === "pushdown"), [
    "face-pull",
    "lateral-raise",
    "db-curl",
    "pushdown",
  ]);
  assert.equal(ids.includes("goblet-or-lunge"), false);
  const dayD = DAYS.find((day) => day.id === "d");
  assert.equal(dayD?.slots.some((slot) => slot.exerciseId === "goblet-or-lunge"), true);
  assert.equal(names.get("goblet-or-lunge")?.includes(" or "), true);
});

test("each movement swaps to a single lift", () => {
  for (const id of ["face-pull", "lateral-raise", "db-curl", "pushdown"]) {
    const subs = SUBSTITUTES[id] ?? [];
    assert.ok(subs.length >= 3, id);
    for (const sub of subs) {
      assert.equal((names.get(sub) ?? "").includes(" + "), false, `${id} -> ${sub}`);
    }
  }
});

test("a superset is one card and rest waits for the round", () => {
  const blocks = exerciseBlocks([
    { name: "Overhead press", supersetGroup: null, supersetOrder: null, sortOrder: 0 },
    { name: "DB curl", supersetGroup: "ss-curl-pushdown", supersetOrder: 1, sortOrder: 1 },
    { name: "Pushdown", supersetGroup: "ss-curl-pushdown", supersetOrder: 2, sortOrder: 2 },
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, "single");
  assert.equal(blocks[1].kind, "superset");
  if (blocks[1].kind === "superset") {
    assert.equal(blocks[1].title, supersetTitle(["DB curl", "Pushdown"]));
    assert.deepEqual(blocks[1].exercises.map((exercise) => exercise.name), ["DB curl", "Pushdown"]);
  }
  const preview = programPreview([
    { id: 1, name: "DB curl", sets: 3, repsLabel: "12", isCardio: false, notes: null, supersetGroup: "ss-curl-pushdown", supersetOrder: 1, sortOrder: 1 },
    { id: 2, name: "Pushdown", sets: 3, repsLabel: "12", isCardio: false, notes: null, supersetGroup: "ss-curl-pushdown", supersetOrder: 2, sortOrder: 2 },
    { id: 3, name: "Easy cardio", sets: 1, repsLabel: "8–10 min", isCardio: true, notes: "8–10 min easy.", supersetGroup: null, supersetOrder: null, sortOrder: 3 },
  ]);
  assert.deepEqual(preview.map((line) => line.name), ["Superset · DB curl + Pushdown", "Easy cardio"]);
  assert.equal(restSecondsForRound([12, 12]), 60);
  assert.equal(restSecondsForRound([12, 6]), 150);
  assert.equal(restSecondsForRound([8, 10]), 90);
});

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const text = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const line = text.split("\n").find((entry) => entry.startsWith("DATABASE_URL="));
  if (!line) throw new Error("DATABASE_URL is required");
  return line.slice("DATABASE_URL=".length).trim().replace(/^"|"$/g, "");
}

test("logged combined sets are copied onto both movements", async () => {
  process.env.DATABASE_URL = databaseUrl();
  const { pool } = await import("../src/server/db");
  const { migrate } = await import("../src/server/schema");
  const { applySupersetSplits } = await import("../src/server/supersetMigrate");
  await migrate();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const fromId = `test-combo-${randomUUID().slice(0, 8)}`;
    const firstId = `test-a-${randomUUID().slice(0, 8)}`;
    const secondId = `test-b-${randomUUID().slice(0, 8)}`;
    const group = `ss-test-${randomUUID().slice(0, 8)}`;
    for (const [id, name] of [[fromId, "Combo + lift"], [firstId, "Combo"], [secondId, "Lift"]] as const) {
      await client.query(
        `INSERT INTO exercises (id, name, pattern_key, pattern_label, muscles, is_cardio, measure)
         VALUES ($1,$2,'test','Test','Test',false,'reps')`,
        [id, name],
      );
    }
    const program = await client.query<{ id: number }>(
      `INSERT INTO program_exercises (day_id, exercise_id, sort_order, sets, reps_label, rep_count, measure)
       VALUES ('c', $1, 50, 2, '12', 12, 'reps') RETURNING id`,
      [fromId],
    );
    const sessionId = randomUUID();
    const sxId = randomUUID();
    await client.query(
      `INSERT INTO sessions (id, day_id, name, started_at, completed_at, week_start, sample)
       VALUES ($1, 'c', 'Full Body C', now(), now(), CURRENT_DATE, true)`,
      [sessionId],
    );
    await client.query(
      `INSERT INTO session_exercises (
         id, session_id, program_exercise_id, exercise_id, name, sort_order, sets, reps_label, rep_count, measure
       ) VALUES ($1,$2,$3,$4,'Combo + lift', 4, 2, '12', 12, 'reps')`,
      [sxId, sessionId, program.rows[0].id, fromId],
    );
    await client.query(
      `INSERT INTO sets (id, session_exercise_id, exercise_id, set_index, weight_lb, reps, is_pr, logged_at)
       VALUES ($1,$2,$3,1,25,12,true,now()), ($4,$2,$3,2,30,10,false,now())`,
      [randomUUID(), sxId, fromId, randomUUID()],
    );
    const split = { fromId, group, movementIds: [firstId, secondId] as [string, string] };
    await applySupersetSplits(client, [split]);
    await applySupersetSplits(client, [split]);
    const copied = await client.query<{ exercise_id: string; superset_order: number; weight_lb: number; reps: number; migrated: boolean }>(
      `SELECT sx.exercise_id, sx.superset_order, s.weight_lb, s.reps, s.migrated
       FROM session_exercises sx
       JOIN sets s ON s.session_exercise_id = sx.id
       WHERE sx.session_id = $1
       ORDER BY sx.superset_order, s.set_index`,
      [sessionId],
    );
    assert.equal(copied.rows.length, 4);
    assert.deepEqual(
      copied.rows.map((row) => [row.exercise_id, row.superset_order, Number(row.weight_lb), Number(row.reps), row.migrated]),
      [
        [firstId, 1, 25, 12, true],
        [firstId, 1, 30, 10, true],
        [secondId, 2, 25, 12, true],
        [secondId, 2, 30, 10, true],
      ],
    );
    const plan = await client.query<{ name: string; superset_group: string | null; superset_order: number | null }>(
      `SELECT e.name, pe.superset_group, pe.superset_order
       FROM program_exercises pe
       JOIN exercises e ON e.id = pe.exercise_id
       WHERE pe.day_id = 'c'
       ORDER BY pe.sort_order`,
    );
    assert.equal(plan.rows.some((row) => row.name.includes(" + ")), false);
    const face = plan.rows.filter((row) => row.superset_group === "ss-face-lateral").map((row) => [row.name, row.superset_order]);
    const arms = plan.rows.filter((row) => row.superset_group === "ss-curl-pushdown").map((row) => [row.name, row.superset_order]);
    assert.deepEqual(face, [["Face pull", 1], ["Lateral raise", 2]]);
    assert.deepEqual(arms, [["DB curl", 1], ["Pushdown", 2]]);
    const leftover = await client.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM sets WHERE exercise_id IN ('curl-pushdown', 'face-pull-lateral')",
    );
    assert.equal(leftover.rows[0].n, 0);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
