import fs from "fs";
import path from "path";
import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "url";
import { estimateMeal } from "./ai";
import {
  COOKIE,
  clearCookie,
  rateLimit,
  presentedWidgetToken,
  secretsMatch,
  sessionCookie,
  widgetTokenOk,
  signSession,
  verifySession,
} from "./auth";
import {
  addSet,
  clearSamples,
  coachReview,
  createMeal,
  deleteFavorite,
  deleteMeal,
  deleteSet,
  discardSession,
  exerciseHistory,
  finishSession,
  foodDay,
  getSession,
  getSettings,
  getToday,
  getWidgetToday,
  getWeek,
  getWeights,
  listHistory,
  logFavorite,
  logSet,
  saveFavorite,
  saveSettings,
  saveWeight,
  startSession,
  swapExercise,
  updateMeal,
  updatePlannedSet,
} from "./data";
import { pool } from "./db";
import { readGlucose } from "./nightscout";
import { cookieValue, HttpError, readDate, safeError } from "./util";

function clientDir(): string | null {
  const candidates = [path.resolve("dist/client")];
  // esbuild's CJS bundle leaves import.meta.url empty. tsx still provides it.
  const metaUrl = import.meta.url;
  if (metaUrl) {
    const here = path.dirname(fileURLToPath(metaUrl));
    candidates.unshift(path.join(here, "client"));
  }
  return candidates.find((dir) => fs.existsSync(path.join(dir, "index.html"))) ?? null;
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function secureCookie(req: Request): boolean {
  return Boolean(req.secure || process.env.NODE_ENV === "production");
}

export function createApp(passcode: string) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Robots-Tag", "noindex");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
    next();
  });
  app.use(express.json({ limit: "6mb" }));

  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false });
    }
  });

  app.post(
    "/api/auth/login",
    asyncRoute(async (req, res) => {
      if (!rateLimit(`login:${req.ip}`, 8, 15 * 60 * 1000)) {
        res.status(429).json({ error: "Too many tries. Wait a few minutes." });
        return;
      }
      const given = typeof req.body?.passcode === "string" ? req.body.passcode : "";
      if (!given || !secretsMatch(given, passcode)) {
        res.status(401).json({ error: "Wrong passcode" });
        return;
      }
      res.setHeader("Set-Cookie", sessionCookie(signSession(passcode), secureCookie(req)));
      res.json({ ok: true });
    }),
  );

  app.post("/api/auth/logout", (req, res) => {
    res.setHeader("Set-Cookie", clearCookie(secureCookie(req)));
    res.json({ ok: true });
  });

  app.get("/api/auth/me", (req, res) => {
    const token = cookieValue(req.headers.cookie, COOKIE);
    if (!token || !verifySession(token, passcode)) {
      res.status(401).json({ error: "Locked" });
      return;
    }
    res.json({ ok: true });
  });

  app.get(
    "/api/coach/review",
    asyncRoute(async (req, res) => {
      const configured = process.env.COACH_API_TOKEN?.trim();
      if (!configured) {
        res.status(503).json({ error: "Coach API is not configured" });
        return;
      }
      const header = req.get("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
      if (!token || !secretsMatch(token, configured)) {
        const allowed = rateLimit(`coach:${req.ip}`, 20, 15 * 60 * 1000);
        res.status(allowed ? 401 : 429).json({ error: allowed ? "Unauthorized" : "Too many tries" });
        return;
      }
      const from = readDate(req.query.from);
      const to = readDate(req.query.to);
      res.setHeader("Cache-Control", "no-store");
      res.json(await coachReview(from, to));
    }),
  );

  app.get(
    "/api/widget/today",
    asyncRoute(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const presented = presentedWidgetToken(req.get("authorization"), req.query.token);
      if (!widgetTokenOk(presented, process.env.WIDGET_TOKEN)) {
        const allowed = rateLimit(`widget:${req.ip}`, 20, 15 * 60 * 1000);
        res.status(allowed ? 401 : 429).json({ error: allowed ? "Unauthorized" : "Too many tries" });
        return;
      }
      res.json(await getWidgetToday());
    }),
  );

  app.use("/api", (req, res, next) => {
    const token = cookieValue(req.headers.cookie, COOKIE);
    if (!token || !verifySession(token, passcode)) {
      res.status(401).json({ error: "Locked" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/api/today", asyncRoute(async (_req, res) => res.json(await getToday())));
  app.get("/api/week", asyncRoute(async (_req, res) => res.json(await getWeek())));
  app.get("/api/settings", asyncRoute(async (_req, res) => res.json(await getSettings())));
  app.put("/api/settings", asyncRoute(async (req, res) => res.json(await saveSettings(req.body ?? {}))));
  app.post("/api/samples/clear", asyncRoute(async (_req, res) => {
    await clearSamples();
    res.json({ ok: true });
  }));

  app.post("/api/sessions", asyncRoute(async (req, res) => {
    const dayId = typeof req.body?.dayId === "string" ? req.body.dayId : "";
    if (!dayId) throw new HttpError(400, "Pick a day");
    res.json(await startSession(dayId));
  }));
  app.get("/api/sessions/:id", asyncRoute(async (req, res) => {
    const session = await getSession(req.params.id);
    if (!session) throw new HttpError(404, "Workout not found");
    res.json(session);
  }));
  app.post("/api/sessions/:id/finish", asyncRoute(async (req, res) => res.json(await finishSession(req.params.id))));
  app.delete("/api/sessions/:id", asyncRoute(async (req, res) => {
    await discardSession(req.params.id);
    res.json({ ok: true });
  }));
  app.post("/api/sessions/:id/swap", asyncRoute(async (req, res) => res.json(await swapExercise(req.params.id, req.body ?? {}))));
  app.post("/api/session-exercises/:id/sets", asyncRoute(async (req, res) => res.json(await addSet(req.params.id))));
  app.patch("/api/sets/:id", asyncRoute(async (req, res) => res.json(await updatePlannedSet(req.params.id, req.body ?? {}))));
  app.post("/api/sets/:id/log", asyncRoute(async (req, res) => res.json(await logSet(req.params.id, req.body ?? {}))));
  app.delete("/api/sets/:id", asyncRoute(async (req, res) => res.json(await deleteSet(req.params.id))));

  app.get("/api/history", asyncRoute(async (_req, res) => res.json(await listHistory())));
  app.get("/api/exercises/:id/history", asyncRoute(async (req, res) => res.json(await exerciseHistory(req.params.id))));

  app.get("/api/meals", asyncRoute(async (req, res) => res.json(await foodDay(req.query.date))));
  app.post("/api/meals", asyncRoute(async (req, res) => res.status(201).json(await createMeal(req.body ?? {}))));
  app.put("/api/meals/:id", asyncRoute(async (req, res) => res.json(await updateMeal(req.params.id, req.body ?? {}))));
  app.delete("/api/meals/:id", asyncRoute(async (req, res) => {
    await deleteMeal(req.params.id);
    res.json({ ok: true });
  }));
  app.post("/api/meals/estimate", asyncRoute(async (req, res) => {
    try {
      const estimate = await estimateMeal({
        note: typeof req.body?.note === "string" ? req.body.note : "",
        imageDataUrl: typeof req.body?.imageDataUrl === "string" ? req.body.imageDataUrl : null,
      });
      res.json(estimate);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const safe =
        message.startsWith("No AI") ||
        message.startsWith("Add a") ||
        message.startsWith("That photo") ||
        message.startsWith("The estimate")
          ? message
          : "The estimate didn't come back. Enter the meal yourself.";
      res.status(400).json({ error: safe });
    }
  }));
  app.post("/api/favorites", asyncRoute(async (req, res) => res.status(201).json(await saveFavorite(req.body ?? {}))));
  app.post("/api/favorites/:id/log", asyncRoute(async (req, res) => res.status(201).json(await logFavorite(req.params.id, req.body ?? {}))));
  app.delete("/api/favorites/:id", asyncRoute(async (req, res) => {
    await deleteFavorite(req.params.id);
    res.json({ ok: true });
  }));

  app.get("/api/weights", asyncRoute(async (_req, res) => res.json(await getWeights())));
  app.post("/api/weights", asyncRoute(async (req, res) => res.json(await saveWeight(req.body ?? {}))));
  app.get("/api/glucose", asyncRoute(async (_req, res) => res.json(await readGlucose())));

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  const client = clientDir();
  if (client) {
    app.use(
      express.static(client, {
        index: false,
        setHeaders(res, filePath) {
          if (filePath.endsWith("index.html") || filePath.endsWith("sw.js") || filePath.endsWith(".webmanifest")) {
            res.setHeader("Cache-Control", "no-store");
          }
        },
      }),
    );
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path === "/health") {
        next();
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(path.join(client, "index.html"));
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    const message = safeError(error);
    if (message.includes("entity.too.large") || message.includes("request entity too large")) {
      res.status(413).json({ error: "That upload is too large" });
      return;
    }
    console.error(message);
    res.status(500).json({ error: "Something went wrong" });
  });

  return app;
}
