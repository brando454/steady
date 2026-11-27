import { randomUUID } from "crypto";
import { pool, rows, tx, type Queryable } from "../db";
import { refreshPrs } from "../data";
import { HttpError } from "../util";
import { wallTimeToUtc, weekStartCivil } from "../../shared/time";
import {
  sourceOf,
  summarizeWeights,
  type ApiToken,
  type AuthCode,
  type CredentialInfo,
  type ExerciseWrite,
  type OauthClient,
  type OauthConnection,
  type RefreshToken,
  type SteadyAudit,
  type SteadyStore,
  type WeighIn,
  type Workout,
  type WorkoutSummary,
  type WorkoutWrite,
} from "./store";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function civil(value: string | Date): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${value.getFullYear()}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

type SessionRow = {
  id: string;
  day_id: string | null;
  name: string;
  started_at: Date;
  completed_at: Date | null;
  source_kind: string | null;
  source_client: string | null;
  deleted_at: Date | string | null;
  boise_date: string | Date;
};

export class PgSteadyStore implements SteadyStore {
  constructor(private readonly db: Queryable = pool) {}

  async listExercises() {
    const found = await rows<{ id: string; name: string; muscles: string; measure: string; is_cardio: boolean }>(
      this.db,
      "SELECT id, name, muscles, measure, is_cardio FROM exercises ORDER BY name",
    );
    return found.map((row) => ({ id: row.id, name: row.name, muscles: row.muscles, measure: row.measure, isCardio: row.is_cardio }));
  }

  async plan() {
    const days = await rows<{ id: string; name: string; summary: string }>(this.db, "SELECT id, name, summary FROM program_days ORDER BY sort_order");
    const slots = await rows<{ day_id: string; exercise_id: string; name: string; sets: number; reps_label: string; notes: string | null }>(
      this.db,
      `SELECT pe.day_id, pe.exercise_id, e.name, pe.sets, pe.reps_label, pe.notes
       FROM program_exercises pe JOIN exercises e ON e.id = pe.exercise_id
       ORDER BY pe.sort_order`,
    );
    return days.map((day) => ({
      id: day.id,
      name: day.name,
      summary: day.summary,
      exercises: slots
        .filter((slot) => slot.day_id === day.id)
        .map((slot) => ({ exerciseId: slot.exercise_id, name: slot.name, sets: slot.sets, repsLabel: slot.reps_label, notes: slot.notes })),
    }));
  }

  async listWorkouts(start: string, end: string) {
    const found = await rows<SessionRow>(
      this.db,
      `SELECT id, day_id, name, started_at, completed_at, source_kind, source_client, deleted_at,
              (started_at AT TIME ZONE 'America/Boise')::date AS boise_date
       FROM sessions
       WHERE deleted_at IS NULL AND (started_at AT TIME ZONE 'America/Boise')::date BETWEEN $1::date AND $2::date
       ORDER BY started_at`,
      [start, end],
    );
    return found.map(summaryRow);
  }

  async listDeletedWorkouts() {
    const found = await rows<SessionRow>(
      this.db,
      `SELECT id, day_id, name, started_at, completed_at, source_kind, source_client, deleted_at,
              (started_at AT TIME ZONE 'America/Boise')::date AS boise_date
       FROM sessions WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
    );
    return found.map((row) => ({ ...summaryRow(row), deletedAt: row.deleted_at ? iso(row.deleted_at) : "" }));
  }

  async getWorkout(id: string) {
    return this.load(id, false);
  }

  async logWorkout(input: WorkoutWrite, client: string, now: Date) {
    await this.requireDay(input.dayId);
    const id = randomUUID();
    const started = wallTimeToUtc(input.date, input.time);
    await tx(async (clientDb) => {
      await clientDb.query(
        `INSERT INTO sessions (id, day_id, name, started_at, completed_at, week_start, sample, source_kind, source_client)
         VALUES ($1,$2,$3,$4,$4,$5,false,'ai',$6)`,
        [id, input.dayId, input.name, started, weekStartCivil(input.date), client],
      );
      await this.writeExercises(clientDb, id, input.exercises);
    });
    await refreshPrs(input.exercises.map((exercise) => exercise.exerciseId));
    return (await this.load(id, false)) as Workout;
  }

  async editWorkout(id: string, input: Partial<WorkoutWrite>, client: string, _now: Date) {
    const existing = await this.load(id, false);
    if (!existing) return null;
    if (input.dayId !== undefined) await this.requireDay(input.dayId);
    const date = input.date ?? existing.date;
    const time = input.time ?? existing.startedAt.slice(11, 16);
    const started = input.date || input.time ? wallTimeToUtc(date, /^\d{2}:\d{2}$/.test(time) ? time : "12:00") : new Date(existing.startedAt);
    await tx(async (clientDb) => {
      await clientDb.query(
        `UPDATE sessions
         SET name = $2, day_id = $3, started_at = $4, completed_at = CASE WHEN completed_at IS NULL THEN completed_at ELSE $4 END,
             week_start = $5, source_kind = 'ai', source_client = $6
         WHERE id = $1 AND deleted_at IS NULL`,
        [id, input.name ?? existing.name, input.dayId === undefined ? existing.dayId : input.dayId, started, weekStartCivil(date), client],
      );
      if (input.exercises) {
        await clientDb.query("DELETE FROM session_exercises WHERE session_id = $1", [id]);
        await this.writeExercises(clientDb, id, input.exercises);
      }
    });
    const ids = [...existing.exercises.map((exercise) => exercise.exerciseId), ...(input.exercises ?? []).map((exercise) => exercise.exerciseId)];
    await refreshPrs(ids);
    return this.load(id, false);
  }

  async deleteWorkout(id: string, now: Date) {
    const result = await this.db.query("UPDATE sessions SET deleted_at = $2 WHERE id = $1 AND deleted_at IS NULL", [id, now]);
    if ((result.rowCount ?? 0) === 0) return false;
    const exercises = await rows<{ exercise_id: string }>(this.db, "SELECT exercise_id FROM session_exercises WHERE session_id = $1", [id]);
    await refreshPrs(exercises.map((row) => row.exercise_id));
    return true;
  }

  async restoreWorkout(id: string) {
    const result = await this.db.query("UPDATE sessions SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL", [id]);
    if ((result.rowCount ?? 0) === 0) return null;
    const exercises = await rows<{ exercise_id: string }>(this.db, "SELECT exercise_id FROM session_exercises WHERE session_id = $1", [id]);
    await refreshPrs(exercises.map((row) => row.exercise_id));
    return this.load(id, false);
  }

  async purgeDeletedWorkouts(now: Date) {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    await this.db.query("DELETE FROM sessions WHERE deleted_at IS NOT NULL AND deleted_at < $1", [cutoff]);
  }

  async logWeight(input: { date: string; weightLb: number; note: string | null }, client: string, now: Date) {
    const at = wallTimeToUtc(input.date, "12:00");
    const found = await rows<{ id: string }>(
      this.db,
      `INSERT INTO weights (id, weighed_on, weight_lb, weighed_at, sample, note, source_kind, source_client)
       VALUES ($1,$2,$3,$4,false,$5,'ai',$6)
       ON CONFLICT (weighed_on) DO UPDATE
         SET weight_lb = EXCLUDED.weight_lb, weighed_at = EXCLUDED.weighed_at, sample = false, note = EXCLUDED.note, source_kind = 'ai', source_client = EXCLUDED.source_client
       RETURNING id`,
      [randomUUID(), input.date, input.weightLb, at, input.note, client],
    );
    return { id: found[0].id, date: input.date, weightLb: input.weightLb, note: input.note, source: { kind: "ai" as const, client } };
  }

  async listWeights(start: string, end: string) {
    const found = await rows<{ id: string; weighed_on: string | Date; weight_lb: number; note: string | null; source_kind: string | null; source_client: string | null }>(
      this.db,
      "SELECT id, weighed_on, weight_lb, note, source_kind, source_client FROM weights WHERE weighed_on <= $1::date ORDER BY weighed_on",
      [end],
    );
    const all = found.map((row) => ({
      id: row.id,
      date: civil(row.weighed_on),
      weightLb: Number(row.weight_lb),
      note: row.note,
      source: sourceOf(row.source_kind, row.source_client),
    }));
    return summarizeWeights(all, start, end);
  }

  async editWeight(id: string, input: { date?: string; weightLb?: number; note?: string | null }, client: string) {
    const current = await rows<{ id: string; weighed_on: string | Date; weight_lb: number; note: string | null }>(
      this.db,
      "SELECT id, weighed_on, weight_lb, note FROM weights WHERE id = $1",
      [id],
    );
    if (!current[0]) return null;
    const date = input.date ?? civil(current[0].weighed_on);
    const weightLb = input.weightLb ?? Number(current[0].weight_lb);
    const note = input.note === undefined ? current[0].note : input.note;
    try {
      await this.db.query(
        "UPDATE weights SET weighed_on = $2, weight_lb = $3, note = $4, weighed_at = $5, source_kind = 'ai', source_client = $6 WHERE id = $1",
        [id, date, weightLb, note, wallTimeToUtc(date, "12:00"), client],
      );
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") throw new HttpError(409, "That day already has a weigh-in");
      throw error;
    }
    return { id, date, weightLb, note, source: { kind: "ai" as const, client } };
  }

  async deleteWeight(id: string) {
    const result = await this.db.query("DELETE FROM weights WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async saveOauthClient(client: OauthClient) {
    await this.db.query("INSERT INTO steady_oauth_clients (id, name, redirect_uris, created_at) VALUES ($1,$2,$3::jsonb,$4)", [
      client.id,
      client.name,
      JSON.stringify(client.redirectUris),
      client.createdAt,
    ]);
  }

  async oauthClient(id: string) {
    const found = await rows<{ id: string; name: string; redirect_uris: string[]; created_at: Date | string }>(
      this.db,
      "SELECT id, name, redirect_uris, created_at FROM steady_oauth_clients WHERE id = $1",
      [id],
    );
    if (!found[0]) return null;
    return { id: found[0].id, name: found[0].name, redirectUris: found[0].redirect_uris, createdAt: iso(found[0].created_at) };
  }

  async saveAuthCode(code: AuthCode) {
    await this.db.query(
      "INSERT INTO steady_oauth_codes (code_hash, client_id, redirect_uri, code_challenge, expires_at) VALUES ($1,$2,$3,$4,$5)",
      [code.codeHash, code.clientId, code.redirectUri, code.codeChallenge, code.expiresAt],
    );
  }

  async peekAuthCode(codeHash: string, now: Date) {
    const found = await rows<{ code_hash: string; client_id: string; redirect_uri: string; code_challenge: string; expires_at: Date | string }>(
      this.db,
      `SELECT code_hash, client_id, redirect_uri, code_challenge, expires_at
       FROM steady_oauth_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2`,
      [codeHash, now],
    );
    if (!found[0]) return null;
    return {
      codeHash: found[0].code_hash,
      clientId: found[0].client_id,
      redirectUri: found[0].redirect_uri,
      codeChallenge: found[0].code_challenge,
      expiresAt: iso(found[0].expires_at),
    };
  }

  async takeAuthCode(codeHash: string, now: Date) {
    const found = await rows<{ code_hash: string; client_id: string; redirect_uri: string; code_challenge: string; expires_at: Date | string }>(
      this.db,
      `UPDATE steady_oauth_codes SET used_at = $2
       WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2
       RETURNING code_hash, client_id, redirect_uri, code_challenge, expires_at`,
      [codeHash, now],
    );
    if (!found[0]) return null;
    return {
      codeHash: found[0].code_hash,
      clientId: found[0].client_id,
      redirectUri: found[0].redirect_uri,
      codeChallenge: found[0].code_challenge,
      expiresAt: iso(found[0].expires_at),
    };
  }

  async saveConnection(connection: OauthConnection) {
    await this.db.query("INSERT INTO steady_oauth_connections (id, client_id, name, created_at) VALUES ($1,$2,$3,$4)", [
      connection.id,
      connection.clientId,
      connection.name,
      connection.createdAt,
    ]);
  }

  async saveApiToken(token: ApiToken) {
    await this.db.query(
      `INSERT INTO steady_api_tokens (id, token_hash, kind, name, client_id, connection_id, expires_at, last_used_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [token.id, token.tokenHash, token.kind, token.name, token.clientId, token.connectionId, token.expiresAt, token.lastUsedAt, token.createdAt],
    );
  }

  async apiTokenForHash(tokenHash: string, now: Date) {
    const found = await rows<{
      id: string;
      token_hash: string;
      kind: "pat" | "oauth";
      name: string;
      client_id: string | null;
      connection_id: string | null;
      expires_at: Date | string | null;
      last_used_at: Date | string | null;
      created_at: Date | string;
    }>(
      this.db,
      `UPDATE steady_api_tokens AS token SET last_used_at = $2
       WHERE token.token_hash = $1 AND token.revoked_at IS NULL AND (token.expires_at IS NULL OR token.expires_at > $2)
         AND (token.connection_id IS NULL OR EXISTS (
           SELECT 1 FROM steady_oauth_connections WHERE id = token.connection_id AND revoked_at IS NULL
         ))
       RETURNING id, token_hash, kind, name, client_id, connection_id, expires_at, last_used_at, created_at`,
      [tokenHash, now],
    );
    const row = found[0];
    if (!row) return null;
    return {
      id: row.id,
      tokenHash: row.token_hash,
      kind: row.kind,
      name: row.name,
      clientId: row.client_id,
      connectionId: row.connection_id,
      expiresAt: row.expires_at == null ? null : iso(row.expires_at),
      lastUsedAt: row.last_used_at == null ? null : iso(row.last_used_at),
      createdAt: iso(row.created_at),
      revokedAt: null,
    };
  }

  async saveRefreshToken(token: RefreshToken) {
    await this.db.query("INSERT INTO steady_refresh_tokens (token_hash, client_id, connection_id, expires_at) VALUES ($1,$2,$3,$4)", [
      token.tokenHash,
      token.clientId,
      token.connectionId,
      token.expiresAt,
    ]);
  }

  async takeRefreshToken(tokenHash: string, now: Date) {
    const found = await rows<{ token_hash: string; client_id: string; connection_id: string; expires_at: Date | string }>(
      this.db,
      `UPDATE steady_refresh_tokens SET revoked_at = $2
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2
       RETURNING token_hash, client_id, connection_id, expires_at`,
      [tokenHash, now],
    );
    if (!found[0]) return null;
    return {
      tokenHash: found[0].token_hash,
      clientId: found[0].client_id,
      connectionId: found[0].connection_id,
      expiresAt: iso(found[0].expires_at),
    };
  }

  async revokeAccessForConnection(connectionId: string) {
    await this.db.query("UPDATE steady_api_tokens SET revoked_at = now() WHERE connection_id = $1 AND revoked_at IS NULL", [connectionId]);
  }

  async listCredentials() {
    const tokens = await rows<{ id: string; name: string; created_at: Date | string; last_used_at: Date | string | null }>(
      this.db,
      "SELECT id, name, created_at, last_used_at FROM steady_api_tokens WHERE kind = 'pat' AND revoked_at IS NULL ORDER BY created_at",
    );
    const connections = await rows<{ id: string; name: string; created_at: Date | string; last_used_at: Date | string | null }>(
      this.db,
      `SELECT connection.id, connection.name, connection.created_at,
              (SELECT max(last_used_at) FROM steady_api_tokens WHERE connection_id = connection.id) AS last_used_at
       FROM steady_oauth_connections connection
       WHERE connection.revoked_at IS NULL ORDER BY connection.created_at`,
    );
    const map = (row: { id: string; name: string; created_at: Date | string; last_used_at: Date | string | null }): CredentialInfo => ({
      id: row.id,
      name: row.name,
      createdAt: iso(row.created_at),
      lastUsedAt: row.last_used_at == null ? null : iso(row.last_used_at),
    });
    return { tokens: tokens.map(map), connections: connections.map(map) };
  }

  async revokeCredential(id: string) {
    const token = await this.db.query("UPDATE steady_api_tokens SET revoked_at = now() WHERE id = $1 AND kind = 'pat' AND revoked_at IS NULL", [id]);
    if ((token.rowCount ?? 0) > 0) return true;
    const connection = await this.db.query("UPDATE steady_oauth_connections SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [id]);
    if ((connection.rowCount ?? 0) === 0) return false;
    await this.revokeAccessForConnection(id);
    await this.db.query("UPDATE steady_refresh_tokens SET revoked_at = now() WHERE connection_id = $1 AND revoked_at IS NULL", [id]);
    return true;
  }

  async insertAudit(event: Omit<SteadyAudit, "id" | "createdAt">, createdAt: Date) {
    await this.db.query(
      "INSERT INTO steady_mcp_audit (id, action, target_kind, target_id, client_name, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [randomUUID(), event.action, event.targetKind, event.targetId, event.clientName, createdAt],
    );
  }

  async listAudits() {
    const found = await rows<{ id: string; action: string; target_kind: "workout" | "weight"; target_id: string | null; client_name: string | null; created_at: Date | string }>(
      this.db,
      "SELECT id, action, target_kind, target_id, client_name, created_at FROM steady_mcp_audit ORDER BY created_at",
    );
    return found.map((row) => ({
      id: row.id,
      action: row.action,
      targetKind: row.target_kind,
      targetId: row.target_id,
      clientName: row.client_name,
      createdAt: iso(row.created_at),
    }));
  }

  private async requireDay(dayId: string | null) {
    if (!dayId) return;
    const found = await rows<{ id: string }>(this.db, "SELECT id FROM program_days WHERE id = $1", [dayId]);
    if (!found[0]) throw new HttpError(400, "That day isn't in the program");
  }

  private async writeExercises(client: Queryable, sessionId: string, exercises: ExerciseWrite[]) {
    for (let index = 0; index < exercises.length; index += 1) {
      const exercise = exercises[index];
      const info = await rows<{ id: string; name: string; measure: string; is_cardio: boolean }>(
        client,
        "SELECT id, name, measure, is_cardio FROM exercises WHERE id = $1",
        [exercise.exerciseId],
      );
      if (!info[0]) throw new HttpError(400, "Exercise not found");
      const sxId = randomUUID();
      await client.query(
        `INSERT INTO session_exercises (
           id, session_id, exercise_id, name, sort_order, sets, reps_label, rep_count, measure, per_side, notes, is_cardio
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11)`,
        [sxId, sessionId, info[0].id, info[0].name, index, Math.max(exercise.sets.length, 1), info[0].is_cardio ? "min" : "reps", 0, info[0].measure, exercise.notes, info[0].is_cardio],
      );
      for (let setIndex = 0; setIndex < exercise.sets.length; setIndex += 1) {
        const set = exercise.sets[setIndex];
        await client.query(
          `INSERT INTO sets (id, session_exercise_id, exercise_id, set_index, weight_lb, reps, duration_sec, note, logged_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
          [randomUUID(), sxId, info[0].id, setIndex, set.weightLb, set.reps, set.durationSec, set.note],
        );
      }
    }
  }

  private async load(id: string, deleted: boolean): Promise<Workout | null> {
    const found = await rows<SessionRow>(
      this.db,
      `SELECT id, day_id, name, started_at, completed_at, source_kind, source_client, deleted_at,
              (started_at AT TIME ZONE 'America/Boise')::date AS boise_date
       FROM sessions WHERE id = $1 AND ${deleted ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"}`,
      [id],
    );
    if (!found[0]) return null;
    const exercises = await rows<{
      id: string;
      exercise_id: string;
      name: string;
      sort_order: number;
      measure: string;
      is_cardio: boolean;
      notes: string | null;
    }>(
      this.db,
      `SELECT id, exercise_id, name, sort_order, measure, is_cardio, notes
       FROM session_exercises WHERE session_id = $1 ORDER BY sort_order`,
      [id],
    );
    const ids = exercises.map((exercise) => exercise.id);
    const sets = ids.length
      ? await rows<{ id: string; session_exercise_id: string; set_index: number; weight_lb: number | null; reps: number | null; duration_sec: number | null; note: string | null }>(
          this.db,
          "SELECT id, session_exercise_id, set_index, weight_lb, reps, duration_sec, note FROM sets WHERE session_exercise_id = ANY($1::uuid[]) ORDER BY set_index",
          [ids],
        )
      : [];
    const row = found[0];
    return {
      id: row.id,
      name: row.name,
      date: civil(row.boise_date),
      dayId: row.day_id,
      startedAt: row.started_at.toISOString(),
      completedAt: row.completed_at ? row.completed_at.toISOString() : null,
      source: sourceOf(row.source_kind, row.source_client),
      deletedAt: row.deleted_at ? iso(row.deleted_at) : null,
      exercises: exercises.map((exercise) => ({
        id: exercise.id,
        exerciseId: exercise.exercise_id,
        name: exercise.name,
        sortOrder: exercise.sort_order,
        measure: exercise.measure,
        isCardio: exercise.is_cardio,
        notes: exercise.notes,
        sets: sets
          .filter((set) => set.session_exercise_id === exercise.id)
          .map((set) => ({
            id: set.id,
            setIndex: set.set_index,
            weightLb: set.weight_lb == null ? null : Number(set.weight_lb),
            reps: set.reps == null ? null : Number(set.reps),
            durationSec: set.duration_sec == null ? null : Number(set.duration_sec),
            note: set.note,
          })),
      })),
    };
  }
}

function summaryRow(row: SessionRow): WorkoutSummary {
  return {
    id: row.id,
    name: row.name,
    date: civil(row.boise_date),
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    source: sourceOf(row.source_kind, row.source_client),
  };
}

