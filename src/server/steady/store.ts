import { createHash, randomUUID } from "crypto";
import { HttpError } from "../util";
import { averageChange, sevenDayAverage, weightHint } from "../../shared/logic";
import { wallTimeToUtc, weekStartCivil } from "../../shared/time";

export type SteadySource = { kind: "app" | "ai"; client: string | null };

export type SetWrite = {
  weightLb: number | null;
  reps: number | null;
  durationSec: number | null;
  note: string | null;
};

export type ExerciseWrite = {
  exerciseId: string;
  notes: string | null;
  sets: SetWrite[];
};

export type WorkoutWrite = {
  name: string;
  date: string;
  time: string;
  dayId: string | null;
  exercises: ExerciseWrite[];
};

export type WorkoutSet = SetWrite & { id: string; setIndex: number };
export type WorkoutExercise = {
  id: string;
  exerciseId: string;
  name: string;
  sortOrder: number;
  measure: string;
  isCardio: boolean;
  notes: string | null;
  sets: WorkoutSet[];
};

export type Workout = {
  id: string;
  name: string;
  date: string;
  dayId: string | null;
  startedAt: string;
  completedAt: string | null;
  source: SteadySource;
  deletedAt: string | null;
  exercises: WorkoutExercise[];
};

export type WorkoutSummary = {
  id: string;
  name: string;
  date: string;
  startedAt: string;
  completedAt: string | null;
  source: SteadySource;
  deletedAt?: string;
};

export type CatalogExercise = { id: string; name: string; muscles: string; measure: string; isCardio: boolean };
export type PlanExercise = { exerciseId: string; name: string; sets: number; repsLabel: string; notes: string | null };
export type PlanDay = { id: string; name: string; summary: string; exercises: PlanExercise[] };

export type WeighIn = { id: string; date: string; weightLb: number; note: string | null; source: SteadySource };
export type WeightList = {
  entries: WeighIn[];
  average: number | null;
  count: number;
  change: number | null;
  hint: ReturnType<typeof weightHint>;
};

export type OauthClient = { id: string; name: string; redirectUris: string[]; createdAt: string };
export type AuthCode = { codeHash: string; clientId: string; redirectUri: string; codeChallenge: string; expiresAt: string };
export type OauthConnection = { id: string; clientId: string; name: string; createdAt: string; revokedAt: string | null };
export type ApiToken = {
  id: string;
  tokenHash: string;
  kind: "pat" | "oauth";
  name: string;
  clientId: string | null;
  connectionId: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
};
export type RefreshToken = { tokenHash: string; clientId: string; connectionId: string; expiresAt: string };
export type CredentialInfo = { id: string; name: string; createdAt: string; lastUsedAt: string | null };
export type SteadyAudit = {
  id: string;
  action: string;
  targetKind: "workout" | "weight";
  targetId: string | null;
  clientName: string | null;
  createdAt: string;
};

export type SteadyStore = {
  listExercises(): Promise<CatalogExercise[]>;
  plan(): Promise<PlanDay[]>;
  listWorkouts(start: string, end: string): Promise<WorkoutSummary[]>;
  listDeletedWorkouts(): Promise<WorkoutSummary[]>;
  getWorkout(id: string): Promise<Workout | null>;
  logWorkout(input: WorkoutWrite, client: string, now: Date): Promise<Workout>;
  editWorkout(id: string, input: Partial<WorkoutWrite> & { exercises?: ExerciseWrite[] }, client: string, now: Date): Promise<Workout | null>;
  deleteWorkout(id: string, now: Date): Promise<boolean>;
  restoreWorkout(id: string): Promise<Workout | null>;
  purgeDeletedWorkouts(now: Date): Promise<void>;
  logWeight(input: { date: string; weightLb: number; note: string | null }, client: string, now: Date): Promise<WeighIn>;
  listWeights(start: string, end: string): Promise<WeightList>;
  editWeight(id: string, input: { date?: string; weightLb?: number; note?: string | null }, client: string): Promise<WeighIn | null>;
  deleteWeight(id: string): Promise<boolean>;
  saveOauthClient(client: OauthClient): Promise<void>;
  oauthClient(id: string): Promise<OauthClient | null>;
  saveAuthCode(code: AuthCode): Promise<void>;
  peekAuthCode(codeHash: string, now: Date): Promise<AuthCode | null>;
  takeAuthCode(codeHash: string, now: Date): Promise<AuthCode | null>;
  saveConnection(connection: OauthConnection): Promise<void>;
  saveApiToken(token: ApiToken): Promise<void>;
  apiTokenForHash(tokenHash: string, now: Date): Promise<ApiToken | null>;
  saveRefreshToken(token: RefreshToken): Promise<void>;
  takeRefreshToken(tokenHash: string, now: Date): Promise<RefreshToken | null>;
  revokeAccessForConnection(connectionId: string): Promise<void>;
  listCredentials(): Promise<{ tokens: CredentialInfo[]; connections: CredentialInfo[] }>;
  revokeCredential(id: string): Promise<boolean>;
  insertAudit(event: Omit<SteadyAudit, "id" | "createdAt">, createdAt: Date): Promise<void>;
  listAudits(): Promise<SteadyAudit[]>;
};

export function sourceOf(kind: string | null, client: string | null): SteadySource {
  return { kind: kind === "ai" ? "ai" : "app", client: client ?? null };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function summarizeWeights(all: WeighIn[], start: string, end: string): WeightList {
  const entries = all.filter((item) => item.date >= start && item.date <= end);
  const prior = all.filter((item) => item.date <= end);
  const average = sevenDayAverage(prior, end);
  const change = averageChange(prior, end);
  return {
    entries,
    average: average ? round1(average.average) : null,
    count: average?.count ?? 0,
    change: change == null ? null : round1(change),
    hint: weightHint(change),
  };
}

export class MemorySteadyStore implements SteadyStore {
  exercises: CatalogExercise[] = [];
  days: PlanDay[] = [];
  workouts: Workout[] = [];
  weights: WeighIn[] = [];
  oauthClients = new Map<string, OauthClient>();
  authCodes = new Map<string, AuthCode & { used: boolean }>();
  connections = new Map<string, OauthConnection>();
  apiTokens: ApiToken[] = [];
  refreshTokens: Array<RefreshToken & { revoked: boolean }> = [];
  audits: SteadyAudit[] = [];

  async listExercises() {
    return this.exercises;
  }

  async plan() {
    return this.days;
  }

  async listWorkouts(start: string, end: string) {
    return this.workouts
      .filter((workout) => !workout.deletedAt && workout.date >= start && workout.date <= end)
      .map(summaryOf);
  }

  async listDeletedWorkouts() {
    return this.workouts.filter((workout) => workout.deletedAt).map((workout) => ({ ...summaryOf(workout), deletedAt: workout.deletedAt as string }));
  }

  async getWorkout(id: string) {
    return this.workouts.find((workout) => workout.id === id && !workout.deletedAt) ?? null;
  }

  async logWorkout(input: WorkoutWrite, client: string, now: Date) {
    this.requireDay(input.dayId);
    const started = wallTimeToUtc(input.date, input.time);
    const workout: Workout = {
      id: randomUUID(),
      name: input.name,
      date: input.date,
      dayId: input.dayId,
      startedAt: started.toISOString(),
      completedAt: started.toISOString(),
      source: { kind: "ai", client },
      deletedAt: null,
      exercises: this.materialize(input.exercises),
    };
    this.workouts.push(workout);
    return workout;
  }

  async editWorkout(id: string, input: Partial<WorkoutWrite>, client: string, _now: Date) {
    const workout = this.workouts.find((item) => item.id === id && !item.deletedAt);
    if (!workout) return null;
    if (input.dayId !== undefined) this.requireDay(input.dayId);
    if (input.name !== undefined) workout.name = input.name;
    if (input.date !== undefined || input.time !== undefined) {
      const date = input.date ?? workout.date;
      const time = input.time ?? workout.startedAt.slice(11, 16);
      const started = wallTimeToUtc(date, /^\d{2}:\d{2}$/.test(time) ? time : "12:00");
      workout.date = date;
      workout.startedAt = started.toISOString();
      workout.completedAt = started.toISOString();
    }
    if (input.dayId !== undefined) workout.dayId = input.dayId;
    if (input.exercises) workout.exercises = this.materialize(input.exercises);
    workout.source = { kind: "ai", client };
    return workout;
  }

  async deleteWorkout(id: string, now: Date) {
    const workout = this.workouts.find((item) => item.id === id && !item.deletedAt);
    if (!workout) return false;
    workout.deletedAt = now.toISOString();
    return true;
  }

  async restoreWorkout(id: string) {
    const workout = this.workouts.find((item) => item.id === id && item.deletedAt);
    if (!workout) return null;
    workout.deletedAt = null;
    return workout;
  }

  async purgeDeletedWorkouts(now: Date) {
    const cutoff = now.getTime() - 30 * 24 * 60 * 60 * 1000;
    this.workouts = this.workouts.filter((workout) => !workout.deletedAt || Date.parse(workout.deletedAt) >= cutoff);
  }

  async logWeight(input: { date: string; weightLb: number; note: string | null }, client: string, _now: Date) {
    const existing = this.weights.find((item) => item.date === input.date);
    if (existing) {
      existing.weightLb = input.weightLb;
      existing.note = input.note;
      existing.source = { kind: "ai", client };
      return existing;
    }
    const saved = { id: randomUUID(), ...input, source: { kind: "ai" as const, client } };
    this.weights.push(saved);
    return saved;
  }

  async listWeights(start: string, end: string) {
    return summarizeWeights([...this.weights].sort((a, b) => a.date.localeCompare(b.date)), start, end);
  }

  async editWeight(id: string, input: { date?: string; weightLb?: number; note?: string | null }, client: string) {
    const row = this.weights.find((item) => item.id === id);
    if (!row) return null;
    if (input.date && this.weights.some((item) => item.id !== id && item.date === input.date)) throw new HttpError(409, "That day already has a weigh-in");
    if (input.date) row.date = input.date;
    if (input.weightLb != null) row.weightLb = input.weightLb;
    if (input.note !== undefined) row.note = input.note;
    row.source = { kind: "ai", client };
    return row;
  }

  async deleteWeight(id: string) {
    const before = this.weights.length;
    this.weights = this.weights.filter((item) => item.id !== id);
    return this.weights.length !== before;
  }

  async saveOauthClient(client: OauthClient) {
    this.oauthClients.set(client.id, client);
  }
  async oauthClient(id: string) {
    return this.oauthClients.get(id) ?? null;
  }
  async saveAuthCode(code: AuthCode) {
    this.authCodes.set(code.codeHash, { ...code, used: false });
  }
  async peekAuthCode(codeHash: string, now: Date) {
    const code = this.authCodes.get(codeHash);
    if (!code || code.used || Date.parse(code.expiresAt) <= now.getTime()) return null;
    return code;
  }
  async takeAuthCode(codeHash: string, now: Date) {
    const code = await this.peekAuthCode(codeHash, now);
    if (!code) return null;
    const row = this.authCodes.get(codeHash);
    if (row) row.used = true;
    return code;
  }
  async saveConnection(connection: OauthConnection) {
    this.connections.set(connection.id, connection);
  }
  async saveApiToken(token: ApiToken) {
    this.apiTokens.push(token);
  }
  async apiTokenForHash(tokenHash: string, now: Date) {
    const token = this.apiTokens.find((item) => item.tokenHash === tokenHash && !item.revokedAt);
    if (!token || (token.expiresAt && Date.parse(token.expiresAt) <= now.getTime())) return null;
    if (token.connectionId) {
      const connection = this.connections.get(token.connectionId);
      if (!connection || connection.revokedAt) return null;
    }
    token.lastUsedAt = now.toISOString();
    return token;
  }
  async saveRefreshToken(token: RefreshToken) {
    this.refreshTokens.push({ ...token, revoked: false });
  }
  async takeRefreshToken(tokenHash: string, now: Date) {
    const token = this.refreshTokens.find((item) => item.tokenHash === tokenHash && !item.revoked);
    if (!token || Date.parse(token.expiresAt) <= now.getTime()) return null;
    token.revoked = true;
    return token;
  }
  async revokeAccessForConnection(connectionId: string) {
    const now = new Date().toISOString();
    for (const token of this.apiTokens) {
      if (token.connectionId === connectionId && !token.revokedAt) token.revokedAt = now;
    }
  }
  async listCredentials() {
    const tokens = this.apiTokens
      .filter((token) => token.kind === "pat" && !token.revokedAt)
      .map((token) => ({ id: token.id, name: token.name, createdAt: token.createdAt, lastUsedAt: token.lastUsedAt }));
    const connections = [...this.connections.values()]
      .filter((connection) => !connection.revokedAt)
      .map((connection) => {
        const used = this.apiTokens.filter((token) => token.connectionId === connection.id && token.lastUsedAt).map((token) => token.lastUsedAt as string).sort();
        return { id: connection.id, name: connection.name, createdAt: connection.createdAt, lastUsedAt: used.at(-1) ?? null };
      });
    return { tokens, connections };
  }
  async revokeCredential(id: string) {
    const token = this.apiTokens.find((item) => item.id === id && item.kind === "pat" && !item.revokedAt);
    if (token) {
      token.revokedAt = new Date().toISOString();
      return true;
    }
    const connection = this.connections.get(id);
    if (!connection || connection.revokedAt) return false;
    connection.revokedAt = new Date().toISOString();
    await this.revokeAccessForConnection(id);
    for (const refresh of this.refreshTokens) {
      if (refresh.connectionId === id) refresh.revoked = true;
    }
    return true;
  }
  async insertAudit(event: Omit<SteadyAudit, "id" | "createdAt">, createdAt: Date) {
    this.audits.push({ ...event, id: randomUUID(), createdAt: createdAt.toISOString() });
  }
  async listAudits() {
    return this.audits;
  }

  private requireDay(dayId: string | null) {
    if (dayId && !this.days.some((day) => day.id === dayId)) throw new HttpError(400, "That day isn't in the program");
  }

  private materialize(exercises: ExerciseWrite[]): WorkoutExercise[] {
    return exercises.map((exercise, index) => {
      const info = this.exercises.find((item) => item.id === exercise.exerciseId);
      if (!info) throw new HttpError(400, "Exercise not found");
      return {
        id: randomUUID(),
        exerciseId: info.id,
        name: info.name,
        sortOrder: index,
        measure: info.measure,
        isCardio: info.isCardio,
        notes: exercise.notes,
        sets: exercise.sets.map((set, setIndex) => ({ ...set, id: randomUUID(), setIndex })),
      };
    });
  }
}

function summaryOf(workout: Workout): WorkoutSummary {
  return {
    id: workout.id,
    name: workout.name,
    date: workout.date,
    startedAt: workout.startedAt,
    completedAt: workout.completedAt,
    source: workout.source,
  };
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
