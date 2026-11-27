import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { signSession } from "../src/server/auth";
import { attachSteadyPublic, attachSteadyTokens } from "../src/server/steady/mount";
import { MemorySteadyStore } from "../src/server/steady/store";
import { HttpError } from "../src/server/util";

const PASSCODE = "steady-test-pass";

function listen(store: MemorySteadyStore, now: () => Date = () => new Date("2026-11-27T18:00:00.000Z")) {
  const app = express();
  app.use(express.json());
  const deps = { store, passcode: PASSCODE, now };
  attachSteadyPublic(app, deps);
  attachSteadyTokens(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: "Something went wrong" });
  });
  const server = createServer(app);
  return new Promise<{ base: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({
        base: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function seed(store: MemorySteadyStore) {
  store.exercises.push({ id: "bench", name: "Bench press", muscles: "chest", measure: "reps", isCardio: false });
  store.days.push({
    id: "push",
    name: "Push",
    summary: "Pressing",
    exercises: [{ exerciseId: "bench", name: "Bench press", sets: 3, repsLabel: "6-8", notes: null }],
  });
}

async function json(response: Response) {
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function mcp(base: string, token: string, method: string, params?: unknown) {
  const response = await fetch(`${base}/api/steady/mcp`, {
    method: "POST",
    headers: {
      Authorization: token ? `Bearer ${token}` : "",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, www: response.headers.get("www-authenticate") };
}

async function tool(base: string, token: string, name: string, args: Record<string, unknown>) {
  const response = await mcp(base, token, "tools/call", { name, arguments: args });
  const result = (response.body.result ?? {}) as { isError?: boolean; structuredContent?: Record<string, unknown> };
  return { status: response.status, result };
}

test("Steady MCP logs workouts and weight for the passcode account", async () => {
  const store = new MemorySteadyStore();
  seed(store);
  const server = await listen(store);
  try {
    const resource = await json(await fetch(`${server.base}/.well-known/oauth-protected-resource/api/steady/mcp`));
    assert.equal(resource.body.resource, `${server.base}/api/steady/mcp`);
    assert.deepEqual(resource.body.authorization_servers, [`${server.base}/api/steady`]);
    const metadata = await json(await fetch(`${server.base}/.well-known/oauth-authorization-server/api/steady`));
    assert.equal(metadata.body.issuer, `${server.base}/api/steady`);
    assert.equal((await fetch(`${server.base}/api/steady/mcp`)).status, 405);
    const anon = await mcp(server.base, "", "initialize");
    assert.equal(anon.status, 401);
    assert.match(anon.www ?? "", /api\/steady\/mcp/);
    const session = signSession(PASSCODE);
    assert.equal((await mcp(server.base, session, "tools/list")).status, 401);
    assert.equal((await mcp(server.base, "abbl_pat_not-a-steady-token", "tools/list")).status, 401);

    const registered = await json(
      await fetch(`${server.base}/api/steady/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Claude", redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none" }),
      }),
    );
    const clientId = registered.body.client_id as string;
    const { verifier, challenge } = pkce();
    const denied = await fetch(`${server.base}/api/steady/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        passcode: "nope",
        client_id: clientId,
        redirect_uri: "http://127.0.0.1/callback",
        state: "s",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    });
    assert.equal(denied.status, 400);
    const signIn = await fetch(`${server.base}/api/steady/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        passcode: PASSCODE,
        client_id: clientId,
        redirect_uri: "http://127.0.0.1/callback",
        state: "s",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: `${server.base}/api/steady/mcp`,
      }),
    });
    assert.equal(signIn.status, 302);
    const code = new URL(signIn.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const exchanged = await json(
      await fetch(`${server.base}/api/steady/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: "http://127.0.0.1/callback",
          code_verifier: verifier,
        }),
      }),
    );
    const access = exchanged.body.access_token as string;
    assert.equal(exchanged.body.expires_in, 3600);

    const plan = await tool(server.base, access, "get_plan", { date: "2026-11-27" });
    assert.equal((plan.result.structuredContent?.days as Array<{ id: string }>)[0].id, "push");
    const logged = await tool(server.base, access, "log_workout", {
      date: "2026-11-27",
      time: "17:30",
      name: "Push",
      dayId: "push",
      exercises: [{ exerciseId: "bench", sets: [{ weightLb: 185, reps: 8, rpe: 8, note: "Secret bench" }] }],
    });
    assert.equal(logged.result.isError, false);
    const workout = logged.result.structuredContent?.workout as {
      id: string;
      source: { kind: string; client: string };
      exercises: Array<{ sets: Array<{ weightLb: number; note: string }> }>;
    };
    assert.equal(workout.source.kind, "ai");
    assert.equal(workout.source.client, "Claude");
    assert.equal(workout.exercises[0].sets[0].weightLb, 185);
    assert.equal(workout.exercises[0].sets[0].note, "Secret bench");
    const edited = await tool(server.base, access, "edit_workout", {
      id: workout.id,
      exercises: [{ exerciseId: "bench", sets: [{ weightLb: 190, reps: 6, note: "Secret bench" }] }],
    });
    assert.equal((edited.result.structuredContent?.workout as { exercises: Array<{ sets: Array<{ weightLb: number }> }> }).exercises[0].sets[0].weightLb, 190);
    const listed = await tool(server.base, access, "list_workouts", { date: "2026-11-27" });
    assert.equal((listed.result.structuredContent?.workouts as unknown[]).length, 1);
    await tool(server.base, access, "delete_workout", { id: workout.id });
    const hidden = await tool(server.base, access, "list_workouts", { date: "2026-11-27" });
    assert.equal((hidden.result.structuredContent?.workouts as unknown[]).length, 0);
    const deleted = await tool(server.base, access, "list_deleted_workouts", {});
    assert.equal((deleted.result.structuredContent?.workouts as Array<{ id: string }>)[0].id, workout.id);
    const restored = await tool(server.base, access, "restore_workout", { id: workout.id });
    assert.equal(restored.result.isError, false);
    const audits = await store.listAudits();
    assert.equal(JSON.stringify(audits).includes("Secret bench"), false);
    assert.equal(audits.some((event) => event.action === "log_workout" && event.clientName === "Claude"), true);

    const weighed = await tool(server.base, access, "log_weight", { date: "2026-11-27", weightLb: 214.2, unit: "lb", note: "morning" });
    assert.equal((weighed.result.structuredContent?.weight as { source: { kind: string } }).source.kind, "ai");
    const weights = await tool(server.base, access, "list_weights", { start: "2026-11-01", end: "2026-11-27" });
    const summary = weights.result.structuredContent as { entries: Array<{ weightLb: number }>; average: number; hint: { tone: string } };
    assert.equal(summary.entries[0].weightLb, 214.2);
    assert.equal(summary.average, 214.2);
    assert.equal(typeof summary.hint.tone, "string");
    const changed = await tool(server.base, access, "edit_weight", { id: (weighed.result.structuredContent?.weight as { id: string }).id, weightLb: 213 });
    assert.equal((changed.result.structuredContent?.weight as { weightLb: number }).weightLb, 213);
    await tool(server.base, access, "delete_weight", { id: (weighed.result.structuredContent?.weight as { id: string }).id });
    const empty = await tool(server.base, access, "list_weights", { start: "2026-11-01", end: "2026-11-27" });
    assert.equal((empty.result.structuredContent?.entries as unknown[]).length, 0);

    const created = await json(
      await fetch(`${server.base}/api/steady/tokens`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Phone" }),
      }),
    );
    const secret = (created.body.token as { token: string; id: string }).token;
    const connections = await json(await fetch(`${server.base}/api/steady/connections`, { headers: { Authorization: `Bearer ${session}` } }));
    assert.equal((connections.body.connections as Array<{ name: string }>)[0].name, "Claude");
    assert.equal(JSON.stringify(connections.body).includes(access), false);
    const revoked = await json(await fetch(`${server.base}/api/steady/tokens/${(connections.body.connections as Array<{ id: string }>)[0].id}`, { method: "DELETE", headers: { Authorization: `Bearer ${session}` } }));
    assert.equal(revoked.status, 200);
    assert.equal((await mcp(server.base, access, "tools/list")).status, 401);
    assert.equal((await mcp(server.base, secret, "ping")).status, 200);
  } finally {
    await server.close();
  }
});

test("deleted Steady workouts purge after 30 days and tokens are rate limited", async () => {
  let clock = new Date("2026-11-27T18:00:00.000Z");
  const store = new MemorySteadyStore();
  seed(store);
  const server = await listen(store, () => clock);
  try {
    const session = signSession(PASSCODE);
    const created = await json(
      await fetch(`${server.base}/api/steady/tokens`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Burst" }),
      }),
    );
    const token = (created.body.token as { token: string }).token;
    const logged = await tool(server.base, token, "log_workout", {
      date: "2026-11-27",
      name: "Push",
      exercises: [{ exerciseId: "bench", sets: [{ weightLb: 100, reps: 5 }] }],
    });
    const id = (logged.result.structuredContent?.workout as { id: string }).id;
    await tool(server.base, token, "delete_workout", { id });
    clock = new Date(clock.getTime() + 31 * 24 * 60 * 60 * 1000);
    const gone = await tool(server.base, token, "list_deleted_workouts", {});
    assert.equal((gone.result.structuredContent?.workouts as unknown[]).length, 0);
    const revive = await tool(server.base, token, "restore_workout", { id });
    assert.equal(revive.result.isError, true);
    const fresh = await json(
      await fetch(`${server.base}/api/steady/tokens`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Limit" }),
      }),
    );
    const limitToken = (fresh.body.token as { token: string }).token;
    let limited = 0;
    for (let i = 0; i < 61; i += 1) {
      if ((await mcp(server.base, limitToken, "ping")).status === 429) limited += 1;
    }
    assert.equal(limited, 1);
  } finally {
    await server.close();
  }
});
