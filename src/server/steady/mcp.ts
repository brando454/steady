import { Router, type Request, type Response } from "express";
import { rateLimit } from "../auth";
import { HttpError, cleanText, readDate } from "../util";
import { steadyOrigin } from "./oauth";
import { tokenHash, type ExerciseWrite, type SetWrite, type SteadyStore, type WorkoutWrite } from "./store";
import type { SteadyDeps } from "./oauth";
import { weekStartCivil } from "../../shared/time";

const PROTOCOL = "2025-03-26";
const SUPPORTED = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);

const SET_SCHEMA = {
  type: "object",
  properties: {
    weightLb: { type: "number" },
    reps: { type: "number" },
    durationSec: { type: "number" },
    note: { type: "string", description: "Set note. Steady has no separate RPE column; put RPE here, or send rpe and it is stored as the note." },
    rpe: { type: "number" },
  },
};

const EXERCISE_SCHEMA = {
  type: "object",
  properties: {
    exerciseId: { type: "string" },
    notes: { type: "string" },
    sets: { type: "array", items: SET_SCHEMA },
  },
  required: ["exerciseId", "sets"],
};

const TOOLS = [
  { name: "list_workouts", description: "Workouts on one date or an inclusive range. Soft-deleted workouts are omitted.", inputSchema: { type: "object", properties: { date: { type: "string" }, start: { type: "string" }, end: { type: "string" } } } },
  { name: "get_workout", description: "One workout with exercises and sets.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "log_workout", description: "Log a finished workout. Sets use weightLb and reps. Cardio uses durationSec. Notes hold RPE when you have one.", inputSchema: { type: "object", properties: { date: { type: "string" }, time: { type: "string" }, name: { type: "string" }, dayId: { type: "string" }, exercises: { type: "array", items: EXERCISE_SCHEMA } }, required: ["date", "name", "exercises"] } },
  { name: "edit_workout", description: "Change a workout. Send exercises to replace the whole exercise and set list. Omit exercises to leave them.", inputSchema: { type: "object", properties: { id: { type: "string" }, date: { type: "string" }, time: { type: "string" }, name: { type: "string" }, dayId: { type: ["string", "null"] }, exercises: { type: "array", items: EXERCISE_SCHEMA } }, required: ["id"] } },
  { name: "delete_workout", description: "Soft-delete a workout for 30 days. It leaves lists until restored.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "restore_workout", description: "Restore a soft-deleted workout.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "list_deleted_workouts", description: "Workouts deleted in the last 30 days.", inputSchema: { type: "object", properties: {} } },
  { name: "list_exercises", description: "The exercise catalog.", inputSchema: { type: "object", properties: {} } },
  { name: "get_plan", description: "The planned program for the week of a date, plus workouts already logged that day.", inputSchema: { type: "object", properties: { date: { type: "string" } }, required: ["date"] } },
  { name: "log_weight", description: "Log body weight in pounds for a date. A second log on the same date replaces it.", inputSchema: { type: "object", properties: { date: { type: "string" }, weightLb: { type: "number" }, unit: { type: "string" }, note: { type: "string" } }, required: ["date", "weightLb"] } },
  { name: "list_weights", description: "Weigh-ins in a date range, plus the 7-day average, change, and hint Steady already uses.", inputSchema: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } }, required: ["start", "end"] } },
  { name: "edit_weight", description: "Change a weigh-in by id.", inputSchema: { type: "object", properties: { id: { type: "string" }, date: { type: "string" }, weightLb: { type: "number" }, note: { type: ["string", "null"] } }, required: ["id"] } },
  { name: "delete_weight", description: "Delete a weigh-in.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

function sendRpc(req: Request, res: Response, body: unknown, status = 200) {
  const accept = req.get("accept") ?? "";
  if (accept.includes("text/event-stream") && !accept.includes("application/json")) {
    res.status(status).set("Content-Type", "text/event-stream").set("Cache-Control", "no-cache");
    res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
    res.end();
    return;
  }
  res.status(status).json(body);
}

function rangeOf(args: Record<string, unknown>): { start: string; end: string } {
  const hasDate = typeof args.date === "string" && args.date !== "";
  const hasRange = (typeof args.start === "string" && args.start !== "") || (typeof args.end === "string" && args.end !== "");
  if (hasDate === hasRange) throw new HttpError(400, "Send a date or a start and end");
  const start = readDate(hasDate ? args.date : args.start);
  const end = readDate(hasDate ? args.date : args.end);
  if (start > end) throw new HttpError(400, "Pick a date");
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
  if (days > 366) throw new HttpError(400, "Pick a shorter range");
  return { start, end };
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value == null || value === "") return null;
  const text = cleanText(value, field, max, false);
  return text || null;
}

function numberOrNull(value: unknown, field: string, max: number): number | null {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max) throw new HttpError(400, `${field} looks off`);
  return Math.round(number * 10) / 10;
}

function readSet(value: unknown, isCardio: boolean): SetWrite {
  if (!value || typeof value !== "object") throw new HttpError(400, "Set looks off");
  const row = value as Record<string, unknown>;
  let note = optionalText(row.note, "Note", 500);
  if (row.rpe != null && row.rpe !== "") {
    const rpe = numberOrNull(row.rpe, "RPE", 10);
    if (rpe != null && rpe < 1) throw new HttpError(400, "RPE looks off");
    if (!note && rpe != null) note = `RPE ${rpe}`;
  }
  const set = {
    weightLb: numberOrNull(row.weightLb, "Weight", 2000),
    reps: numberOrNull(row.reps, "Reps", 500),
    durationSec: numberOrNull(row.durationSec, "Duration", 8 * 60 * 60),
    note,
  };
  if (isCardio) {
    if (set.durationSec == null || set.durationSec <= 0) throw new HttpError(400, "Enter the minutes as durationSec");
  } else if (set.weightLb == null || set.reps == null || set.reps <= 0) {
    throw new HttpError(400, "Enter the weight and reps");
  }
  return set;
}

function readExercises(value: unknown, cardio: Set<string>): ExerciseWrite[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 40) throw new HttpError(400, "Add at least one exercise");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new HttpError(400, "Exercise looks off");
    const row = item as Record<string, unknown>;
    const exerciseId = typeof row.exerciseId === "string" ? row.exerciseId.trim() : "";
    if (!exerciseId || exerciseId.length > 80) throw new HttpError(400, "Exercise looks off");
    const sets = Array.isArray(row.sets) ? row.sets : null;
    if (!sets || sets.length < 1 || sets.length > 30) throw new HttpError(400, "Add at least one set");
    return { exerciseId, notes: optionalText(row.notes, "Notes", 500), sets: sets.map((set) => readSet(set, cardio.has(exerciseId))) };
  });
}

function readTime(value: unknown): string {
  if (value == null || value === "") return "12:00";
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new HttpError(400, "Pick a time");
  return value;
}

async function callTool(store: SteadyStore, client: string, name: string, args: Record<string, unknown>, now: Date) {
  await store.purgeDeletedWorkouts(now);
  if (name === "list_exercises") return { exercises: await store.listExercises() };
  if (name === "list_workouts") {
    const range = rangeOf(args);
    return { ...range, workouts: await store.listWorkouts(range.start, range.end) };
  }
  if (name === "get_workout") {
    const id = typeof args.id === "string" ? args.id : "";
    const workout = id ? await store.getWorkout(id) : null;
    if (!workout) throw new HttpError(404, "Workout not found");
    return { workout };
  }
  if (name === "get_plan") {
    const date = readDate(args.date);
    const days = await store.plan();
    const workouts = await store.listWorkouts(date, date);
    return { date, weekStart: weekStartCivil(date), days, workouts };
  }
  if (name === "log_workout" || name === "edit_workout") {
    const catalog = await store.listExercises();
    const cardio = new Set(catalog.filter((exercise) => exercise.isCardio).map((exercise) => exercise.id));
    const exercises = args.exercises == null ? undefined : readExercises(args.exercises, cardio);
    if (name === "log_workout") {
      if (!exercises) throw new HttpError(400, "Add at least one exercise");
      const workout = await store.logWorkout(
        {
          name: cleanText(args.name, "Name", 80),
          date: readDate(args.date),
          time: readTime(args.time),
          dayId: args.dayId == null || args.dayId === "" ? null : cleanText(args.dayId, "Day", 80),
          exercises,
        },
        client,
        now,
      );
      await store.insertAudit({ action: "log_workout", targetKind: "workout", targetId: workout.id, clientName: client }, now);
      return { workout };
    }
    const id = typeof args.id === "string" ? args.id : "";
    const patch: Partial<WorkoutWrite> = {};
    if (args.name != null) patch.name = cleanText(args.name, "Name", 80);
    if (args.date != null && args.date !== "") patch.date = readDate(args.date);
    if (args.time != null && args.time !== "") patch.time = readTime(args.time);
    if (args.dayId === null) patch.dayId = null;
    else if (typeof args.dayId === "string" && args.dayId) patch.dayId = cleanText(args.dayId, "Day", 80);
    if (exercises) patch.exercises = exercises;
    const workout = id ? await store.editWorkout(id, patch, client, now) : null;
    if (!workout) throw new HttpError(404, "Workout not found");
    await store.insertAudit({ action: "edit_workout", targetKind: "workout", targetId: workout.id, clientName: client }, now);
    return { workout };
  }
  if (name === "delete_workout") {
    const id = typeof args.id === "string" ? args.id : "";
    if (!id || !(await store.deleteWorkout(id, now))) throw new HttpError(404, "Workout not found");
    await store.insertAudit({ action: "delete_workout", targetKind: "workout", targetId: id, clientName: client }, now);
    return { ok: true, id };
  }
  if (name === "restore_workout") {
    const id = typeof args.id === "string" ? args.id : "";
    const workout = id ? await store.restoreWorkout(id) : null;
    if (!workout) throw new HttpError(404, "Workout not found");
    await store.insertAudit({ action: "restore_workout", targetKind: "workout", targetId: id, clientName: client }, now);
    return { workout };
  }
  if (name === "list_deleted_workouts") return { workouts: await store.listDeletedWorkouts() };
  if (name === "log_weight") {
    if (args.unit != null && args.unit !== "" && args.unit !== "lb") throw new HttpError(400, "Weight is stored in lb");
    const weightLb = numberOrNull(args.weightLb, "Weight", 600);
    if (weightLb == null || weightLb < 50) throw new HttpError(400, "Weight looks off");
    const entry = await store.logWeight({ date: readDate(args.date), weightLb, note: optionalText(args.note, "Note", 500) }, client, now);
    await store.insertAudit({ action: "log_weight", targetKind: "weight", targetId: entry.id, clientName: client }, now);
    return { weight: entry };
  }
  if (name === "list_weights") {
    const range = rangeOf(args);
    return store.listWeights(range.start, range.end);
  }
  if (name === "edit_weight") {
    const id = typeof args.id === "string" ? args.id : "";
    const patch: { date?: string; weightLb?: number; note?: string | null } = {};
    if (args.date != null && args.date !== "") patch.date = readDate(args.date);
    if (args.weightLb != null) {
      const weightLb = numberOrNull(args.weightLb, "Weight", 600);
      if (weightLb == null || weightLb < 50) throw new HttpError(400, "Weight looks off");
      patch.weightLb = weightLb;
    }
    if (args.note !== undefined) patch.note = optionalText(args.note, "Note", 500);
    const weight = id ? await store.editWeight(id, patch, client) : null;
    if (!weight) throw new HttpError(404, "Weigh-in not found");
    await store.insertAudit({ action: "edit_weight", targetKind: "weight", targetId: weight.id, clientName: client }, now);
    return { weight };
  }
  if (name === "delete_weight") {
    const id = typeof args.id === "string" ? args.id : "";
    if (!id || !(await store.deleteWeight(id))) throw new HttpError(404, "Weigh-in not found");
    await store.insertAudit({ action: "delete_weight", targetKind: "weight", targetId: id, clientName: client }, now);
    return { ok: true, id };
  }
  throw new HttpError(400, "Unknown tool");
}

export function createSteadyMcpRouter(deps: SteadyDeps): Router {
  const store = deps.store;
  const now = deps.now ?? (() => new Date());
  const router = Router();
  router.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id");
    res.set("Access-Control-Expose-Headers", "WWW-Authenticate");
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.status(204).end();
      return;
    }
    next();
  });
  router.post("/", (req, res, next) => {
    void (async () => {
      const clock = now();
      const origin = steadyOrigin(req);
      const unauthorized = () => {
        res.set("WWW-Authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/steady/mcp"`);
        res.status(401).json({ error: "Sign in required" });
      };
      const version = req.get("mcp-protocol-version");
      if (version && !SUPPORTED.has(version)) {
        res.status(400).json({ error: "Unsupported MCP protocol version" });
        return;
      }
      const match = /^Bearer\s+(\S+)$/i.exec((req.get("authorization") ?? "").trim());
      const secret = match?.[1] ?? "";
      const api = secret ? await store.apiTokenForHash(tokenHash(secret), clock) : null;
      if (!api) {
        if (!rateLimit(`steady-mcp-ip:${req.ip || "unknown"}`, 30, 60_000, clock.getTime())) {
          res.set("Retry-After", "60");
          res.status(429).json({ error: "Too many requests" });
          return;
        }
        unauthorized();
        return;
      }
      if (!rateLimit(`steady-mcp:${api.id}`, 60, 60_000, clock.getTime())) {
        res.set("Retry-After", "60");
        res.status(429).json({ error: "Too many requests" });
        return;
      }
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        sendRpc(req, res, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, 400);
        return;
      }
      const message = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
      const id = message.id ?? null;
      if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        sendRpc(req, res, { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } }, 400);
        return;
      }
      if (id == null || message.method.startsWith("notifications/")) {
        res.status(202).end();
        return;
      }
      const protocol = version && SUPPORTED.has(version) ? version : PROTOCOL;
      if (message.method === "initialize") {
        const requested = (message.params as { protocolVersion?: string } | undefined)?.protocolVersion;
        sendRpc(req, res, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: requested && SUPPORTED.has(requested) ? requested : protocol,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "steady", version: "1.0.0" },
          },
        });
        return;
      }
      if (message.method === "ping") {
        sendRpc(req, res, { jsonrpc: "2.0", id, result: {} });
        return;
      }
      if (message.method === "tools/list") {
        sendRpc(req, res, { jsonrpc: "2.0", id, result: { tools: TOOLS } });
        return;
      }
      if (message.method === "tools/call") {
        const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
        const tool = typeof params.name === "string" ? params.name : "";
        const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
        try {
          const structured = await callTool(store, api.name.slice(0, 80), tool, args, clock);
          sendRpc(req, res, {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError: false },
          });
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          sendRpc(req, res, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: error.message }], isError: true } });
        }
        return;
      }
      sendRpc(req, res, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    })().catch(next);
  });
  router.all("/", (_req, res) => {
    res.set("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
  });
  return router;
}
