import { randomUUID } from "crypto";
import { rows, type Queryable } from "./db";
import { annotatePrs } from "../shared/logic";
import { EXERCISES, SUBSTITUTES } from "../shared/program";
import { PLAN_SUPERSETS, type SupersetSplit } from "../shared/superset";

export async function syncExerciseCatalog(client: Queryable): Promise<void> {
  for (const exercise of EXERCISES) {
    await client.query(
      `INSERT INTO exercises (id, name, pattern_key, pattern_label, muscles, is_cardio, measure)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         pattern_key = EXCLUDED.pattern_key,
         pattern_label = EXCLUDED.pattern_label,
         muscles = EXCLUDED.muscles,
         is_cardio = EXCLUDED.is_cardio,
         measure = EXCLUDED.measure`,
      [
        exercise.id,
        exercise.name,
        exercise.patternKey,
        exercise.patternLabel,
        exercise.muscles,
        Boolean(exercise.isCardio),
        exercise.measure ?? "reps",
      ],
    );
  }
  for (const [exerciseId, subs] of Object.entries(SUBSTITUTES)) {
    for (let index = 0; index < subs.length; index += 1) {
      await client.query(
        `INSERT INTO exercise_substitutes (exercise_id, substitute_id, sort_order)
         VALUES ($1,$2,$3)
         ON CONFLICT (exercise_id, substitute_id) DO NOTHING`,
        [exerciseId, subs[index], index],
      );
    }
  }
}

async function recompute(client: Queryable, exerciseId: string): Promise<void> {
  const logged = await rows<{ id: string; weight_lb: number | null; reps: number | null }>(
    client,
    "SELECT id, weight_lb, reps FROM sets WHERE exercise_id = $1 AND logged_at IS NOT NULL ORDER BY logged_at, set_index",
    [exerciseId],
  );
  const annotated = annotatePrs(
    logged.map((row) => ({
      id: row.id,
      weightLb: row.weight_lb == null ? null : Number(row.weight_lb),
      reps: row.reps == null ? null : Number(row.reps),
    })),
  );
  for (const set of annotated) {
    await client.query("UPDATE sets SET is_pr = $1, pr_kind = $2 WHERE id = $3", [set.isPr, set.kind, set.id]);
  }
}

type ProgramSlot = {
  id: number;
  day_id: string;
  sort_order: number;
  sets: number;
  reps_label: string;
  rep_count: number;
  measure: string;
  per_side: boolean;
  notes: string | null;
  is_cardio: boolean;
  cardio_min: number | null;
};

type SessionSlot = {
  id: string;
  session_id: string;
  sort_order: number;
  sets: number;
  reps_label: string;
  rep_count: number;
  measure: string;
  per_side: boolean;
  notes: string | null;
  is_cardio: boolean;
  cardio_min: number | null;
};

type CopiedSet = {
  set_index: number;
  weight_lb: number | null;
  reps: number | null;
  duration_sec: number | null;
  note: string | null;
  logged_at: Date | null;
};

export async function applySupersetSplits(client: Queryable, splits: SupersetSplit[]): Promise<void> {
  for (const split of splits) {
    const [firstId, secondId] = split.movementIds;
    const names = await rows<{ id: string; name: string }>(
      client,
      "SELECT id, name FROM exercises WHERE id = ANY($1::text[])",
      [[firstId, secondId]],
    );
    const nameOf = new Map(names.map((row) => [row.id, row.name]));
    if (!nameOf.get(firstId) || !nameOf.get(secondId)) continue;

    const programRows = await rows<ProgramSlot>(
      client,
      `SELECT id, day_id, sort_order, sets, reps_label, rep_count, measure, per_side, notes, is_cardio, cardio_min
       FROM program_exercises
       WHERE exercise_id = $1
       ORDER BY sort_order DESC, id DESC`,
      [split.fromId],
    );
    for (const row of programRows) {
      await client.query(
        `UPDATE program_exercises
         SET exercise_id = $1, superset_group = $2, superset_order = 1
         WHERE id = $3`,
        [firstId, split.group, row.id],
      );
      await client.query(
        `UPDATE program_exercises
         SET sort_order = sort_order + 1
         WHERE day_id = $1 AND sort_order > $2`,
        [row.day_id, row.sort_order],
      );
      await client.query(
        `INSERT INTO program_exercises (
           day_id, exercise_id, sort_order, sets, reps_label, rep_count, measure, per_side, notes, is_cardio, cardio_min,
           superset_group, superset_order
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,2)`,
        [
          row.day_id,
          secondId,
          row.sort_order + 1,
          row.sets,
          row.reps_label,
          row.rep_count,
          row.measure,
          row.per_side,
          row.notes,
          row.is_cardio,
          row.cardio_min,
          split.group,
        ],
      );
    }

    const sessionRows = await rows<SessionSlot>(
      client,
      `SELECT id, session_id, sort_order, sets, reps_label, rep_count, measure, per_side, notes, is_cardio, cardio_min
       FROM session_exercises
       WHERE exercise_id = $1
       ORDER BY sort_order DESC, id DESC`,
      [split.fromId],
    );
    for (const row of sessionRows) {
      await client.query(
        `UPDATE session_exercises
         SET exercise_id = $1, name = $2, superset_group = $3, superset_order = 1
         WHERE id = $4`,
        [firstId, nameOf.get(firstId), split.group, row.id],
      );
      await client.query(
        `UPDATE sets
         SET exercise_id = $1, migrated = (logged_at IS NOT NULL)
         WHERE session_exercise_id = $2`,
        [firstId, row.id],
      );
      await client.query(
        `UPDATE session_exercises
         SET sort_order = sort_order + 1
         WHERE session_id = $1 AND sort_order > $2`,
        [row.session_id, row.sort_order],
      );
      const partnerId = randomUUID();
      await client.query(
        `INSERT INTO session_exercises (
           id, session_id, program_exercise_id, exercise_id, name, sort_order, sets, reps_label, rep_count,
           measure, per_side, notes, is_cardio, cardio_min, superset_group, superset_order
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,2)`,
        [
          partnerId,
          row.session_id,
          null,
          secondId,
          nameOf.get(secondId),
          row.sort_order + 1,
          row.sets,
          row.reps_label,
          row.rep_count,
          row.measure,
          row.per_side,
          row.notes,
          row.is_cardio,
          row.cardio_min,
          split.group,
        ],
      );
      const link = await rows<{ id: number }>(
        client,
        `SELECT pe.id
         FROM program_exercises pe
         JOIN sessions s ON s.day_id = pe.day_id
         WHERE s.id = $1 AND pe.superset_group = $2 AND pe.superset_order = 2
         ORDER BY pe.id DESC
         LIMIT 1`,
        [row.session_id, split.group],
      );
      if (link[0]) {
        await client.query("UPDATE session_exercises SET program_exercise_id = $1 WHERE id = $2", [link[0].id, partnerId]);
      }
      const sets = await rows<CopiedSet>(
        client,
        `SELECT set_index, weight_lb, reps, duration_sec, note, logged_at
         FROM sets WHERE session_exercise_id = $1 ORDER BY set_index`,
        [row.id],
      );
      for (const set of sets) {
        await client.query(
          `INSERT INTO sets (
             id, session_exercise_id, exercise_id, set_index, weight_lb, reps, duration_sec, note, is_pr, pr_kind, logged_at, migrated
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,NULL,$9,$10)`,
          [
            randomUUID(),
            partnerId,
            secondId,
            set.set_index,
            set.weight_lb,
            set.reps,
            set.duration_sec,
            set.note,
            set.logged_at,
            set.logged_at != null,
          ],
        );
      }
    }

    await recompute(client, firstId);
    await recompute(client, secondId);
  }
}

export async function migrateSupersets(client: Queryable): Promise<void> {
  await syncExerciseCatalog(client);
  await applySupersetSplits(client, PLAN_SUPERSETS);
}
