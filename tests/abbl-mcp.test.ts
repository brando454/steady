import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { MemoryAbblStore } from "../src/server/abbl/memory";
import { attachAbbl } from "../src/server/abbl/mount";
import { HttpError } from "../src/server/util";

const SETUP = "setup-secret-for-tests";

function listen(store: MemoryAbblStore, now: () => Date = () => new Date("2026-11-14T18:00:00.000Z")) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  attachAbbl(app, { store, now });
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

async function json(response: Response) {
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function mcp(base: string, token: string, method: string, params?: unknown, id: number | null = 1) {
  const response = await fetch(`${base}/api/abbl/mcp`, {
    method: "POST",
    headers: {
      Authorization: token ? `Bearer ${token}` : "",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, www: response.headers.get("www-authenticate") };
}

async function tool(base: string, token: string, name: string, args: Record<string, unknown>) {
  const response = await mcp(base, token, "tools/call", { name, arguments: args });
  const result = (response.body.result ?? {}) as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ text: string }> };
  return { status: response.status, result, text: result.content?.[0]?.text ?? "" };
}

test("MCP discovery, OAuth, meals, and isolation", async () => {
  process.env.ABBL_ADMIN_SETUP_CODE = SETUP;
  const store = new MemoryAbblStore();
  const server = await listen(store);
  try {
    const resource = await json(await fetch(`${server.base}/.well-known/oauth-protected-resource/api/abbl/mcp`));
    assert.equal(resource.body.resource, `${server.base}/api/abbl/mcp`);
    const metadata = await json(await fetch(`${server.base}/.well-known/oauth-authorization-server`));
    assert.equal(metadata.body.registration_endpoint, `${server.base}/api/abbl/oauth/register`);
    assert.deepEqual(metadata.body.code_challenge_methods_supported, ["S256"]);
    const missing = await mcp(server.base, "", "initialize", {});
    assert.equal(missing.status, 401);
    assert.match(missing.www ?? "", /resource_metadata=/);
    const get = await fetch(`${server.base}/api/abbl/mcp`);
    assert.equal(get.status, 405);

    const registered = await json(
      await fetch(`${server.base}/api/abbl/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Claude",
          redirect_uris: ["http://127.0.0.1/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    assert.equal(registered.status, 201);
    const clientId = registered.body.client_id as string;
    const { verifier, challenge } = pkce();
    const state = "state-1";
    const signIn = await fetch(`${server.base}/api/abbl/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        code: SETUP,
        client_id: clientId,
        redirect_uri: "http://127.0.0.1/callback",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: `${server.base}/api/abbl/mcp`,
      }),
    });
    assert.equal(signIn.status, 302);
    const redirected = new URL(signIn.headers.get("location") ?? "");
    assert.equal(redirected.searchParams.get("state"), state);
    const code = redirected.searchParams.get("code") ?? "";
    const bad = await fetch(`${server.base}/api/abbl/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: "http://127.0.0.1/callback",
        code_verifier: "a".repeat(43),
      }),
    });
    assert.equal(bad.status, 400);
    const exchanged = await json(
      await fetch(`${server.base}/api/abbl/oauth/token`, {
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
    assert.equal(exchanged.status, 200);
    const access = exchanged.body.access_token as string;
    const listed = await mcp(server.base, access, "tools/list");
    const names = ((listed.body.result as { tools: Array<{ name: string }> }).tools).map((item) => item.name);
    assert.deepEqual(names, ["log_meal", "edit_meal", "delete_meal", "list_meals", "get_totals"]);

    const admin = await json(
      await fetch(`${server.base}/api/abbl/v1/auth/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: SETUP, name: "Brandon" }),
      }),
    );
    const session = admin.body.token as string;
    const sessionMcp = await mcp(server.base, session, "tools/list");
    assert.equal(sessionMcp.status, 401);
    const appMeal = await json(
      await fetch(`${server.base}/api/abbl/v1/meals`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          date: "2026-11-14",
          time: "08:00",
          meal: "breakfast",
          items: [{ name: "Oats", grams: 40, nutrients: { kcal: 150, protein_g: 5, carbs_g: 27, fat_g: 3, fiber_g: 4 } }],
        }),
      }),
    );
    assert.equal((appMeal.body.meal as { source: { kind: string } }).source.kind, "app");
    assert.equal((appMeal.body.meal as { totals: { fiber_g: number } }).totals.fiber_g, 4);

    const logged = await tool(server.base, access, "log_meal", {
      date: "2020-05-01",
      meal: "lunch",
      name: "Hidden soup",
      totals: { kcal: 400, protein_g: 20, carbs_g: 30, fat_g: 18, fiber_g: 6 },
    });
    assert.equal(logged.result.isError, false);
    const meal = logged.result.structuredContent?.meal as {
      id: string;
      time: string;
      source: { kind: string; client: string };
      items: Array<{ grams: number | null; nutrients: { fiber_g: number } }>;
      totals: { fiber_g: number };
    };
    assert.equal(meal.source.kind, "ai");
    assert.equal(meal.source.client, "Claude");
    assert.equal(meal.time, "18:00");
    assert.equal(meal.items[0].grams, null);
    assert.equal(meal.totals.fiber_g, 6);
    const edited = await tool(server.base, access, "edit_meal", {
      id: meal.id,
      date: "2024-01-02",
      time: "19:00",
      meal: "dinner",
      name: "Hidden soup",
      totals: { kcal: 410, protein_g: 21, carbs_g: 31, fat_g: 18, fiber_g: 7 },
    });
    assert.equal((edited.result.structuredContent?.meal as { date: string; meal: string }).date, "2024-01-02");
    assert.equal((edited.result.structuredContent?.meal as { meal: string }).meal, "dinner");
    const day = await tool(server.base, access, "list_meals", { date: "2024-01-02" });
    assert.equal((day.result.structuredContent?.totals as { kcal: number; fiber_g: number }).kcal, 410);
    assert.equal((day.result.structuredContent?.totals as { fiber_g: number }).fiber_g, 7);
    const range = await tool(server.base, access, "get_totals", { start: "2024-01-01", end: "2024-01-02" });
    assert.equal((range.result.structuredContent?.totals as { kcal: number }).kcal, 410);
    const future = await tool(server.base, access, "log_meal", {
      date: "2099-01-01",
      totals: { kcal: 1, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
    });
    assert.equal(future.result.isError, true);

    const audits = await store.listAudits((await store.findAdmin())?.id ?? "");
    assert.equal(audits.length >= 2, true);
    assert.equal(JSON.stringify(audits).includes("Hidden soup"), false);
    assert.equal(audits.some((event) => event.action === "log_meal" && event.clientName === "Claude"), true);

    const invite = await json(
      await fetch(`${server.base}/api/abbl/v1/admin/invites`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Kate" }),
      }),
    );
    const kate = await json(
      await fetch(`${server.base}/api/abbl/v1/auth/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: invite.body.code }),
      }),
    );
    const kateToken = await json(
      await fetch(`${server.base}/api/abbl/v1/tokens`, {
        method: "POST",
        headers: { Authorization: `Bearer ${kate.body.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Kate laptop" }),
      }),
    );
    assert.equal(kateToken.status, 201);
    const secret = (kateToken.body.token as { token: string; id: string }).token;
    const kateList = await tool(server.base, secret, "list_meals", { date: "2024-01-02" });
    assert.equal((kateList.result.structuredContent?.meals as unknown[]).length, 0);
    assert.equal((kateList.result.structuredContent?.totals as { kcal: number }).kcal, 0);
    const stolen = await tool(server.base, secret, "delete_meal", { id: meal.id });
    assert.equal(stolen.result.isError, true);
    const stillThere = await tool(server.base, access, "list_meals", { date: "2024-01-02" });
    assert.equal((stillThere.result.structuredContent?.meals as unknown[]).length, 1);

    const connections = await json(
      await fetch(`${server.base}/api/abbl/v1/connections`, { headers: { Authorization: `Bearer ${session}` } }),
    );
    const oauthId = (connections.body.connections as Array<{ id: string; name: string }>)[0];
    assert.equal(oauthId.name, "Claude");
    assert.equal(JSON.stringify(connections.body).includes(access), false);
    const revoked = await json(
      await fetch(`${server.base}/api/abbl/v1/tokens/${oauthId.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${session}` } }),
    );
    assert.equal(revoked.status, 200);
    const after = await mcp(server.base, access, "tools/list");
    assert.equal(after.status, 401);
    const kateRevoke = await json(
      await fetch(`${server.base}/api/abbl/v1/tokens/${(kateToken.body.token as { id: string }).id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${kate.body.token}` },
      }),
    );
    assert.equal(kateRevoke.status, 200);
    assert.equal((await mcp(server.base, secret, "tools/list")).status, 401);
  } finally {
    delete process.env.ABBL_ADMIN_SETUP_CODE;
    await server.close();
  }
});

test("deleted meals stay out of totals and purge after 30 days", async () => {
  process.env.ABBL_ADMIN_SETUP_CODE = SETUP;
  let clock = new Date("2026-11-14T18:00:00.000Z");
  const store = new MemoryAbblStore();
  const server = await listen(store, () => clock);
  try {
    const admin = await json(
      await fetch(`${server.base}/api/abbl/v1/auth/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: SETUP }),
      }),
    );
    const auth = { Authorization: `Bearer ${admin.body.token}`, "Content-Type": "application/json" };
    const created = await json(
      await fetch(`${server.base}/api/abbl/v1/tokens`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Phone" }) }),
    );
    const token = (created.body.token as { token: string }).token;
    const logged = await tool(server.base, token, "log_meal", {
      date: "2026-11-14",
      meal: "snack",
      name: "Apple",
      totals: { kcal: 80, protein_g: 0, carbs_g: 21, fat_g: 0, fiber_g: 4 },
    });
    const id = (logged.result.structuredContent?.meal as { id: string }).id;
    const removed = await tool(server.base, token, "delete_meal", { id });
    assert.equal(removed.result.isError, false);
    const day = await tool(server.base, token, "get_totals", { date: "2026-11-14" });
    assert.equal((day.result.structuredContent?.totals as { kcal: number }).kcal, 0);
    const deleted = await json(await fetch(`${server.base}/api/abbl/v1/meals/deleted`, { headers: auth }));
    assert.equal((deleted.body.meals as Array<{ id: string; deletedAt: string }>)[0].id, id);
    const restored = await json(await fetch(`${server.base}/api/abbl/v1/meals/${id}/restore`, { method: "POST", headers: auth }));
    assert.equal(restored.status, 200);
    const back = await tool(server.base, token, "get_totals", { date: "2026-11-14" });
    assert.equal((back.result.structuredContent?.totals as { fiber_g: number }).fiber_g, 4);
    await json(await fetch(`${server.base}/api/abbl/v1/meals/${id}`, { method: "DELETE", headers: auth }));
    clock = new Date(clock.getTime() + 31 * 24 * 60 * 60 * 1000);
    const gone = await json(await fetch(`${server.base}/api/abbl/v1/meals/deleted`, { headers: auth }));
    assert.equal((gone.body.meals as unknown[]).length, 0);
    const revive = await json(await fetch(`${server.base}/api/abbl/v1/meals/${id}/restore`, { method: "POST", headers: auth }));
    assert.equal(revive.status, 404);
  } finally {
    delete process.env.ABBL_ADMIN_SETUP_CODE;
    await server.close();
  }
});

test("MCP writes are rate limited per user", async () => {
  process.env.ABBL_ADMIN_SETUP_CODE = SETUP;
  const server = await listen(new MemoryAbblStore());
  try {
    const admin = await json(
      await fetch(`${server.base}/api/abbl/v1/auth/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: SETUP }),
      }),
    );
    const created = await json(
      await fetch(`${server.base}/api/abbl/v1/tokens`, {
        method: "POST",
        headers: { Authorization: `Bearer ${admin.body.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Burst" }),
      }),
    );
    const token = (created.body.token as { token: string }).token;
    let limited = 0;
    for (let i = 0; i < 61; i += 1) {
      const response = await mcp(server.base, token, "ping");
      if (response.status === 429) limited += 1;
    }
    assert.equal(limited, 1);
  } finally {
    delete process.env.ABBL_ADMIN_SETUP_CODE;
    await server.close();
  }
});
