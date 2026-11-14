import { Router } from "express";
import { rateLimit } from "../auth";
import { HttpError } from "../util";
import { emailConfigured, sendSignInCode } from "./email";
import { lookupBarcode, searchRestaurants, searchUsda } from "./foods";
import { totalNutrients } from "./nutrients";
import type { AbblStore } from "./records";
import {
  CODE_TTL_MS,
  START_BODY,
  adminEmail,
  assertAdmin,
  codeHash,
  itemsFromMealBody,
  newCode,
  newToken,
  presentMeal,
  presentRecipe,
  publicUser,
  readMealMeta,
  readRecipeBody,
  requireUser,
  tokenHash,
} from "./service";
import { suggestTargets } from "./targets";
import { estimatePhotos, helpRecipe, jpegDataUrl, scanLabel } from "./vision";

export type AbblDeps = {
  store: AbblStore;
  now?: () => Date;
  fetch?: typeof fetch;
  sendCode?: (email: string, code: string) => Promise<void>;
  emailReady?: () => boolean;
};

function asyncRoute(fn: (req: import("express").Request, res: import("express").Response) => Promise<unknown>) {
  return (req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
    fn(req, res).catch(next);
  };
}

export function createAbblRouter(deps: AbblDeps): Router {
  const store = deps.store;
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetch ?? fetch;
  const ready = deps.emailReady ?? emailConfigured;
  const send = deps.sendCode ?? sendSignInCode;
  const router = Router();

  router.post(
    "/auth/start",
    asyncRoute(async (req, res) => {
      if (!ready()) throw new HttpError(503, "Email sign-in is not configured");
      const ip = req.ip || "unknown";
      if (!rateLimit(`abbl-start:${ip}`, 8, 15 * 60 * 1000, now().getTime())) {
        throw new HttpError(429, "Too many tries. Wait a few minutes.");
      }
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      if (email && !rateLimit(`abbl-start-email:${email}`, 5, 15 * 60 * 1000, now().getTime())) {
        throw new HttpError(429, "Too many tries. Wait a few minutes.");
      }
      const normalized = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : null;
      const valid = normalized && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
      if (valid && (await store.isAllowed(valid))) {
        const code = newCode();
        await store.saveCode(valid, codeHash(valid, code), new Date(now().getTime() + CODE_TTL_MS));
        try {
          await send(valid, code);
        } catch {
          /* Same response either way, so the allow list stays private. The code is not logged. */
        }
      }
      res.json(START_BODY);
    }),
  );

  router.post(
    "/auth/verify",
    asyncRoute(async (req, res) => {
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(code)) {
        throw new HttpError(401, "That code is not valid");
      }
      const match = await store.consumeCode(email, codeHash(email, code), now());
      if (!match || !(await store.isAllowed(email))) throw new HttpError(401, "That code is not valid");
      let user = await store.userByEmail(email);
      if (user?.disabled) throw new HttpError(403, "This account is disabled");
      if (!user) user = await store.createUser(email);
      const token = newToken();
      await store.saveToken(user.id, tokenHash(token));
      res.json({ token, user: publicUser(user, adminEmail()) });
    }),
  );

  router.post(
    "/auth/logout",
    asyncRoute(async (req, res) => {
      const header = req.get("authorization");
      const match = /^Bearer\s+(\S+)$/i.exec((header ?? "").trim());
      if (!match) throw new HttpError(401, "Sign in required");
      await store.revokeToken(tokenHash(match[1]));
      res.json({ ok: true });
    }),
  );

  router.get(
    "/me",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      res.json({ user: publicUser(user, adminEmail()) });
    }),
  );

  router.get(
    "/admin/invites",
    asyncRoute(async (req, res) => {
      assertAdmin(await requireUser(store, req.get("authorization")));
      res.json({ invites: await store.listInvites() });
    }),
  );

  router.post(
    "/admin/invites",
    asyncRoute(async (req, res) => {
      assertAdmin(await requireUser(store, req.get("authorization")));
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Email looks off");
      await store.allow(email);
      res.status(201).json({ email, status: (await store.userByEmail(email))?.disabled === false ? "joined" : "invited" });
    }),
  );

  router.delete(
    "/admin/invites/:email",
    asyncRoute(async (req, res) => {
      assertAdmin(await requireUser(store, req.get("authorization")));
      const email = decodeURIComponent(req.params.email).trim().toLowerCase();
      if (!(await store.unallow(email))) throw new HttpError(404, "Invite not found");
      res.json({ ok: true });
    }),
  );

  router.delete(
    "/admin/users/:id",
    asyncRoute(async (req, res) => {
      const admin = await requireUser(store, req.get("authorization"));
      assertAdmin(admin);
      if (req.params.id === admin.id) throw new HttpError(400, "The admin account stays");
      if (!(await store.disableUser(req.params.id))) throw new HttpError(404, "User not found");
      res.json({ ok: true });
    }),
  );

  router.get(
    "/targets",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      res.json({ targets: await store.getTargets(user.id) });
    }),
  );

  router.put(
    "/targets",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      const nutrients = readRecipeBodySafeTargets(req.body);
      res.json({ targets: await store.putTargets(user.id, nutrients) });
    }),
  );

  router.post(
    "/targets/suggest",
    asyncRoute(async (req, res) => {
      await requireUser(store, req.get("authorization"));
      const body = req.body ?? {};
      res.json({
        targets: suggestTargets({
          sex: String(body.sex ?? ""),
          age: Number(body.age),
          heightCm: Number(body.heightCm),
          weightKg: Number(body.weightKg),
          activity: String(body.activity ?? ""),
          goal: String(body.goal ?? ""),
        }),
      });
    }),
  );

  router.get(
    "/foods/search",
    asyncRoute(async (req, res) => {
      await requireUser(store, req.get("authorization"));
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (q.length < 2) throw new HttpError(400, "Enter a food to search");
      res.json({ foods: await searchUsda(q.slice(0, 80), fetchImpl) });
    }),
  );

  router.get(
    "/foods/barcode/:upc",
    asyncRoute(async (req, res) => {
      await requireUser(store, req.get("authorization"));
      const upc = req.params.upc.replace(/\s/g, "");
      if (!/^\d{8,14}$/.test(upc)) throw new HttpError(400, "That barcode looks off");
      const food = await lookupBarcode(upc, fetchImpl);
      if (!food) throw new HttpError(404, "No food found for that barcode");
      res.json({ food });
    }),
  );

  router.get(
    "/restaurants/search",
    asyncRoute(async (req, res) => {
      await requireUser(store, req.get("authorization"));
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (q.length < 2) throw new HttpError(400, "Enter a restaurant item to search");
      res.json({ items: await searchRestaurants(q.slice(0, 80), fetchImpl) });
    }),
  );

  router.post(
    "/estimate",
    asyncRoute(async (req, res) => {
      await requireUser(store, req.get("authorization"));
      const photos = Array.isArray(req.body?.photos) ? req.body.photos : null;
      if (!photos || photos.length < 1 || photos.length > 6) throw new HttpError(400, "Send 1 to 6 JPEG photos");
      const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) : null;
      const ingredients = await estimatePhotos(photos.map(jpegDataUrl), note || null, fetchImpl);
      res.json({ ingredients });
    }),
  );

  router.post(
    "/label-scan",
    asyncRoute(async (req, res) => {
      await requireUser(store, req.get("authorization"));
      res.json(await scanLabel(jpegDataUrl(req.body?.photo), fetchImpl));
    }),
  );

  router.post(
    "/recipe-helper",
    asyncRoute(async (req, res) => {
      await requireUser(store, req.get("authorization"));
      const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
      if (!description) throw new HttpError(400, "Describe the meal");
      const messages = Array.isArray(req.body?.messages) ? req.body.messages : undefined;
      res.json(await helpRecipe(description, messages, fetchImpl));
    }),
  );

  router.get(
    "/recipes",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      const recipes = await store.listRecipes(user.id);
      res.json({ recipes: recipes.map(presentRecipe) });
    }),
  );

  router.post(
    "/recipes",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      const recipe = await store.insertRecipe(user.id, readRecipeBody(req.body ?? {}));
      res.status(201).json({ recipe: presentRecipe(recipe) });
    }),
  );

  router.get(
    "/recipes/:id",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      const recipe = await store.getRecipe(user.id, req.params.id);
      if (!recipe) throw new HttpError(404, "Recipe not found");
      res.json({ recipe: presentRecipe(recipe) });
    }),
  );

  router.put(
    "/recipes/:id",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      const recipe = await store.updateRecipe(user.id, req.params.id, readRecipeBody(req.body ?? {}));
      if (!recipe) throw new HttpError(404, "Recipe not found");
      res.json({ recipe: presentRecipe(recipe) });
    }),
  );

  router.delete(
    "/recipes/:id",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      if (!(await store.deleteRecipe(user.id, req.params.id))) throw new HttpError(404, "Recipe not found");
      res.json({ ok: true });
    }),
  );

  router.post(
    "/recipes/:id/share",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      const toUserId = typeof req.body?.toUserId === "string" ? req.body.toUserId : "";
      const toSteady = req.body?.toSteady === true;
      if (toSteady === Boolean(toUserId)) throw new HttpError(400, "Choose one recipient");
      if (toSteady) {
        assertAdmin(user);
        const recipe = await store.getRecipe(user.id, req.params.id);
        if (!recipe) throw new HttpError(404, "Recipe not found");
        const per = presentRecipe(recipe).perServing;
        const favorite = await store.insertSteadyFavorite({
          name: recipe.name.slice(0, 80),
          calories: per.kcal,
          protein: per.protein_g,
          carbs: per.carbs_g,
          fat: per.fat_g,
        });
        res.status(201).json({ favorite });
        return;
      }
      const recipient = await store.userById(toUserId);
      if (!recipient || recipient.disabled) throw new HttpError(404, "User not found");
      if (recipient.id === user.id) throw new HttpError(400, "Choose someone else");
      const copy = await store.copyRecipe(user.id, req.params.id, recipient.id);
      if (!copy) throw new HttpError(404, "Recipe not found");
      res.status(201).json({ recipe: presentRecipe(copy) });
    }),
  );

  router.get(
    "/days/:date",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) throw new HttpError(400, "Pick a date");
      const meals = await store.listMeals(user.id, req.params.date);
      const totals = totalNutrients(meals.flatMap((meal) => meal.items.map((item) => item.nutrients)));
      res.json({
        date: req.params.date,
        targets: await store.getTargets(user.id),
        meals: meals.map(presentMeal),
        totals,
      });
    }),
  );

  router.post(
    "/meals",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      const meta = readMealMeta(req.body ?? {});
      const items = await itemsFromMealBody(store, user.id, req.body ?? {});
      const meal = await store.insertMeal(user.id, { ...meta, items });
      res.status(201).json({ meal: presentMeal(meal) });
    }),
  );

  router.put(
    "/meals/:id",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      const meta = readMealMeta(req.body ?? {});
      const items = await itemsFromMealBody(store, user.id, req.body ?? {});
      const meal = await store.updateMeal(user.id, req.params.id, { ...meta, items });
      if (!meal) throw new HttpError(404, "Meal not found");
      res.json({ meal: presentMeal(meal) });
    }),
  );

  router.delete(
    "/meals/:id",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      if (!(await store.deleteMeal(user.id, req.params.id))) throw new HttpError(404, "Meal not found");
      res.json({ ok: true });
    }),
  );

  return router;
}

function readRecipeBodySafeTargets(body: unknown) {
  if (!body || typeof body !== "object") throw new HttpError(400, "Targets are missing");
  const record = body as Record<string, unknown>;
  const fiber = record.fiber_g;
  if (fiber == null) throw new HttpError(400, "fiber_g looks off");
  return {
    kcal: numberField(record.kcal, "kcal"),
    protein_g: numberField(record.protein_g, "protein_g"),
    carbs_g: numberField(record.carbs_g, "carbs_g"),
    fat_g: numberField(record.fat_g, "fat_g"),
    fiber_g: numberField(fiber, "fiber_g"),
  };
}

function numberField(value: unknown, field: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 20_000) throw new HttpError(400, `${field} looks off`);
  return Math.round(number * 10) / 10;
}
