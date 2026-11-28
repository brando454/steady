import { Router, type Request, type Response } from "express";
import { rateLimit } from "../auth";
import { HttpError } from "../util";
import { readIngredient, readNutrients, totalNutrients, type Ingredient } from "./nutrients";
import { publicOrigin } from "./oauth";
import type { AbblStore, AbblUser, McpAudit } from "./records";
import { presentMeal, readLoggedDate, readMealMeta, tokenHash } from "./service";

const PROTOCOL = "2025-03-26";
const SUPPORTED = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const NUTRIENT_SCHEMA = {
  type: "object",
  properties: {
    kcal: { type: "number" },
    protein_g: { type: "number" },
    carbs_g: { type: "number" },
    fat_g: { type: "number" },
    fiber_g: { type: ["number", "null"] },
  },
  required: ["kcal", "protein_g", "carbs_g", "fat_g"],
};

const TOOLS = [
  {
    name: "log_meal",
    description: "Log one meal for the signed-in user. Send items or totals, not both. fiber_g may be null when unknown.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD. Past days are allowed." },
        time: { type: "string", description: "HH:mm. Optional." },
        meal: { type: "string", enum: ["breakfast", "lunch", "snack", "dinner"] },
        name: { type: "string" },
        note: { type: "string" },
        items: { type: "array", items: { type: "object" } },
        totals: NUTRIENT_SCHEMA,
      },
      required: ["date"],
    },
  },
  {
    name: "edit_meal",
    description: "Replace one meal. Same fields as log_meal, plus id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        date: { type: "string" },
        time: { type: "string" },
        meal: { type: "string", enum: ["breakfast", "lunch", "snack", "dinner"] },
        name: { type: "string" },
        note: { type: "string" },
        items: { type: "array", items: { type: "object" } },
        totals: NUTRIENT_SCHEMA,
      },
      required: ["id", "date"],
    },
  },
  {
    name: "delete_meal",
    description: "Soft-delete one meal. It stays in Recently deleted for 30 days and drops out of lists and totals.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "list_meals",
    description: "List one day's meals and totals, including fiber. Deleted meals are omitted.",
    inputSchema: { type: "object", properties: { date: { type: "string" } }, required: ["date"] },
  },
  {
    name: "get_totals",
    description: "Totals for one day or an inclusive date range, including fiber. Deleted meals are omitted.",
    inputSchema: {
      type: "object",
      properties: { date: { type: "string" }, start: { type: "string" }, end: { type: "string" } },
    },
  },
];

function sendRpc(req: Request, res: Response, body: unknown, status = 200) {
  const accept = req.get("accept") ?? "";
  if (accept.includes("text/event-stream") && !accept.includes("application/json")) {
    res.status(status);
    res.set("Content-Type", "text/event-stream");
    res.set("Cache-Control", "no-cache");
    res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
    res.end();
    return;
  }
  res.status(status).json(body);
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: (error: unknown) => void) => {
    fn(req, res).catch(next);
  };
}

function itemsFromTool(body: Record<string, unknown>): Ingredient[] {
  const hasItems = Array.isArray(body.items);
  const hasTotals = body.totals != null && body.totals !== "";
  if (hasItems === hasTotals) throw new HttpError(400, "Send items or totals");
  if (hasItems) {
    const items = body.items as unknown[];
    if (items.length < 1 || items.length > 80) throw new HttpError(400, "Add at least one item");
    return items.map((item) => readIngredient(item));
  }
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 120) : "Meal";
  return [{ name, quantity: null, unit: null, grams: null, nutrients: readNutrients(body.totals), source: "ai", edited: true, foodRef: null }];
}

function mealFromTool(body: Record<string, unknown>, now: Date, clientName: string) {
  const time = body.time == null || body.time === "" ? now.toISOString().slice(11, 16) : body.time;
  const meta = readMealMeta({ ...body, time, source: { kind: "ai", client: clientName } }, now);
  return { ...meta, source: { kind: "ai" as const, client: clientName }, deletedAt: null, items: itemsFromTool(body) };
}

async function audit(store: AbblStore, event: Omit<McpAudit, "id" | "createdAt">, now: Date) {
  await store.insertAudit(event, now);
}

async function callTool(store: AbblStore, user: AbblUser, clientName: string, name: string, args: Record<string, unknown>, now: Date) {
  await store.purgeDeletedMeals(now);
  if (name === "log_meal") {
    const meal = await store.insertMeal(user.id, mealFromTool(args, now, clientName));
    await audit(store, { userId: user.id, action: "log_meal", mealId: meal.id, clientName }, now);
    return { meal: presentMeal(meal) };
  }
  if (name === "edit_meal") {
    const id = typeof args.id === "string" ? args.id : "";
    const meal = id ? await store.updateMeal(user.id, id, mealFromTool(args, now, clientName)) : null;
    if (!meal) throw new HttpError(404, "Meal not found");
    await audit(store, { userId: user.id, action: "edit_meal", mealId: meal.id, clientName }, now);
    return { meal: presentMeal(meal) };
  }
  if (name === "delete_meal") {
    const id = typeof args.id === "string" ? args.id : "";
    if (!id || !(await store.deleteMeal(user.id, id, now))) throw new HttpError(404, "Meal not found");
    await audit(store, { userId: user.id, action: "delete_meal", mealId: id, clientName }, now);
    return { ok: true, id };
  }
  if (name === "list_meals") {
    const date = readLoggedDate(args.date, now);
    const meals = await store.listMeals(user.id, date);
    return { date, meals: meals.map(presentMeal), totals: totalNutrients(meals.flatMap((meal) => meal.items.map((item) => item.nutrients))) };
  }
  if (name === "get_totals") {
    const hasDate = typeof args.date === "string" && args.date !== "";
    const hasRange = (typeof args.start === "string" && args.start !== "") || (typeof args.end === "string" && args.end !== "");
    if (hasDate === hasRange) throw new HttpError(400, "Send a date or a start and end");
    const start = readLoggedDate(hasDate ? args.date : args.start, now);
    const end = readLoggedDate(hasDate ? args.date : args.end, now);
    if (start > end) throw new HttpError(400, "Pick a date");
    const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
    if (days > 366) throw new HttpError(400, "Pick a shorter range");
    const meals = await store.listMealsBetween(user.id, start, end);
    const byDate = new Map<string, ReturnType<typeof totalNutrients>>();
    for (const meal of meals) {
      const nutrients = meal.items.map((item) => item.nutrients);
      const current = byDate.get(meal.date);
      byDate.set(meal.date, totalNutrients([...(current ? [current] : []), ...nutrients]));
    }
    const all = meals.flatMap((meal) => meal.items.map((item) => item.nutrients));
    return {
      start,
      end,
      days: [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, totals]) => ({ date, totals })),
      totals: totalNutrients(all),
    };
  }
  throw new HttpError(400, "Unknown tool");
}

export function createMcpRouter(deps: OauthDepsLike): Router {
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
  router.post(
    "/",
    asyncRoute(async (req, res) => {
      const clock = now();
      const origin = publicOrigin(req);
      const unauthorized = () => {
        res.set("WWW-Authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/abbl/mcp"`);
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
      const user = api ? await store.userById(api.userId) : null;
      if (!api || !user) {
        if (!rateLimit(`abbl-mcp-ip:${req.ip || "unknown"}`, 30, 60_000, clock.getTime())) {
          res.set("Retry-After", "60");
          res.status(429).json({ error: "Too many requests" });
          return;
        }
        return unauthorized();
      }
      if (!rateLimit(`abbl-mcp:${user.id}`, 60, 60_000, clock.getTime())) {
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
            serverInfo: { name: "abbl", version: "1.0.0" },
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
          const structured = await callTool(store, user, api.name.slice(0, 80), tool, args, clock);
          sendRpc(req, res, {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError: false },
          });
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          sendRpc(req, res, {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: error.message }], isError: true },
          });
        }
        return;
      }
      sendRpc(req, res, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }),
  );
  router.all("/", (_req, res) => {
    res.set("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
  });
  return router;
}

type OauthDepsLike = { store: AbblStore; now?: () => Date };
