import { randomUUID } from "crypto";
import { Router } from "express";
import { rateLimit } from "../auth";
import { HttpError, cleanText } from "../util";
import { lookupBarcode, searchRestaurants, searchUsda } from "./foods";
import { totalNutrients } from "./nutrients";
import type { AbblStore, AbblUser } from "./records";
import {
  INVITE_TTL_MS,
  assertAdmin,
  codeHash,
  itemsFromMealBody,
  newInviteCode,
  newPrefixedToken,
  newToken,
  presentInvite,
  presentDeletedMeal,
  presentMeal,
  presentRecipe,
  publicUser,
  readMealMeta,
  readOptionalEmail,
  readPersonName,
  readRecipeBody,
  requireUser,
  tokenHash,
  userFromCode,
} from "./service";
import { suggestTargets } from "./targets";
import { estimatePhotos, helpRecipe, jpegDataUrl, readEstimateFocus, scanLabel } from "./vision";

export type AbblDeps = {
  store: AbblStore;
  now?: () => Date;
  fetch?: typeof fetch;
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
  const router = Router();

  async function issueToken(user: AbblUser) {
    const token = newToken();
    await store.saveToken(user.id, tokenHash(token));
    return { token, user: publicUser(user) };
  }

  async function issueInvite(admin: AbblUser, input: { name: string; email: string | null; userId: string | null }) {
    const code = newInviteCode();
    const invite = await store.insertInvite({
      codeHash: codeHash(code),
      name: input.name,
      email: input.email,
      userId: input.userId,
      createdBy: admin.id,
      expiresAt: new Date(now().getTime() + INVITE_TTL_MS),
    });
    return { invite: presentInvite(invite, now()), code };
  }

  router.post(
    "/auth/redeem",
    asyncRoute(async (req, res) => {
      const ip = req.ip || "unknown";
      if (!rateLimit(`abbl-redeem:${ip}`, 8, 15 * 60 * 1000, now().getTime())) {
        throw new HttpError(429, "Too many tries. Wait a few minutes.");
      }
      const code = typeof req.body?.code === "string" ? req.body.code : "";
      const name = readPersonName(req.body?.name, false);
      const user = await userFromCode(store, code, name, now());
      res.json(await issueToken(user));
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
      res.json({ user: publicUser(user) });
    }),
  );

  router.get(
    "/admin/invites",
    asyncRoute(async (req, res) => {
      assertAdmin(await requireUser(store, req.get("authorization")));
      const invites = await store.listInvites();
      const users = await store.listUsers();
      res.json({
        invites: invites.map((invite) => presentInvite(invite, now())),
        users: users.map((person) => ({ ...publicUser(person), disabled: person.disabled })),
      });
    }),
  );

  router.post(
    "/admin/invites",
    asyncRoute(async (req, res) => {
      const admin = await requireUser(store, req.get("authorization"));
      assertAdmin(admin);
      const name = readPersonName(req.body?.name, true);
      const email = readOptionalEmail(req.body?.email);
      res.status(201).json(await issueInvite(admin, { name: name ?? "Guest", email, userId: null }));
    }),
  );

  router.delete(
    "/admin/invites/:id",
    asyncRoute(async (req, res) => {
      assertAdmin(await requireUser(store, req.get("authorization")));
      if (!(await store.revokeInvite(req.params.id))) throw new HttpError(404, "Invite not found");
      res.json({ ok: true });
    }),
  );

  router.post(
    "/admin/users/:id/invite",
    asyncRoute(async (req, res) => {
      const admin = await requireUser(store, req.get("authorization"));
      assertAdmin(admin);
      const person = await store.userById(req.params.id);
      if (!person) throw new HttpError(404, "User not found");
      if (person.disabled) throw new HttpError(400, "This account is disabled");
      res.status(201).json(await issueInvite(admin, { name: person.name, email: person.email, userId: person.id }));
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
      const photos = Array.isArray(req.body?.photos) ? req.body.photos : [];
      const focus = readEstimateFocus(req.body ?? {});
      if (photos.length > 6 || (photos.length < 1 && !focus)) throw new HttpError(400, "Send 1 to 6 JPEG photos");
      const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) : null;
      const ingredients = await estimatePhotos(photos.map(jpegDataUrl), note || null, fetchImpl, undefined, focus);
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
      await store.purgeDeletedMeals(now());
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
      const meta = readMealMeta(req.body ?? {}, now());
      const items = await itemsFromMealBody(store, user.id, req.body ?? {});
      const meal = await store.insertMeal(user.id, { ...meta, deletedAt: null, items });
      res.status(201).json({ meal: presentMeal(meal) });
    }),
  );

  router.put(
    "/meals/:id",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      const meta = readMealMeta(req.body ?? {}, now());
      const items = await itemsFromMealBody(store, user.id, req.body ?? {});
      const meal = await store.updateMeal(user.id, req.params.id, { ...meta, deletedAt: null, items });
      if (!meal) throw new HttpError(404, "Meal not found");
      res.json({ meal: presentMeal(meal) });
    }),
  );

  router.delete(
    "/meals/:id",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      await store.purgeDeletedMeals(now());
      if (!(await store.deleteMeal(user.id, req.params.id, now()))) throw new HttpError(404, "Meal not found");
      res.json({ ok: true });
    }),
  );

  router.get(
    "/meals/deleted",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      await store.purgeDeletedMeals(now());
      const meals = await store.listDeletedMeals(user.id);
      res.json({ meals: meals.map(presentDeletedMeal) });
    }),
  );

  router.post(
    "/meals/:id/restore",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      await store.purgeDeletedMeals(now());
      const meal = await store.restoreMeal(user.id, req.params.id);
      if (!meal) throw new HttpError(404, "Meal not found");
      res.json({ meal: presentMeal(meal) });
    }),
  );

  router.post(
    "/tokens",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      const name = cleanText(req.body?.name, "Name", 80);
      const secret = newPrefixedToken("abbl_pat");
      const createdAt = now().toISOString();
      const id = randomUUID();
      await store.saveApiToken({
        id,
        userId: user.id,
        tokenHash: tokenHash(secret),
        kind: "pat",
        name,
        clientId: null,
        connectionId: null,
        expiresAt: null,
        lastUsedAt: null,
        createdAt,
        revokedAt: null,
      });
      res.status(201).json({ token: { id, name, token: secret, createdAt } });
    }),
  );

  router.get(
    "/connections",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      res.json(await store.listCredentials(user.id));
    }),
  );

  router.delete(
    "/tokens/:id",
    asyncRoute(async (req, res) => {
      const user = await requireUser(store, req.get("authorization"));
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) throw new HttpError(404, "Connection not found");
      if (!(await store.revokeCredential(user.id, req.params.id))) throw new HttpError(404, "Connection not found");
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
