import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import express from "express";
import { resetRateLimit } from "../src/server/auth";
import { MemoryAbblStore } from "../src/server/abbl/memory";
import { totalNutrients } from "../src/server/abbl/nutrients";
import { createAbblRouter } from "../src/server/abbl/router";
import { suggestTargets } from "../src/server/abbl/targets";
import { parseOpenFoodFacts, parseUsdaFoods } from "../src/server/abbl/foods";
import { HttpError } from "../src/server/util";

const oats = {
  name: "Oats",
  grams: 100,
  source: "manual",
  nutrients: { kcal: 200, protein_g: 10, carbs_g: 30, fat_g: 4, fiber_g: 5 as number | null },
};

function listen(store: MemoryAbblStore, sent: { email: string; code: string }[], ready = true) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(
    "/api/abbl/v1",
    createAbblRouter({
      store,
      emailReady: () => ready,
      sendCode: async (email, code) => {
        sent.push({ email, code });
      },
      now: () => new Date("2026-11-14T18:00:00.000Z"),
    }),
  );
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

test("fiber null stays unknown and a listed zero does not", () => {
  const unknown = totalNutrients([{ kcal: 10, protein_g: 1, carbs_g: 1, fat_g: 1, fiber_g: null }]);
  assert.equal(unknown.fiber_g, null);
  assert.equal(unknown.fiber_unknown, true);
  const mixed = totalNutrients([
    { kcal: 10, protein_g: 1, carbs_g: 1, fat_g: 1, fiber_g: null },
    { kcal: 10, protein_g: 1, carbs_g: 1, fat_g: 1, fiber_g: 0 },
  ]);
  assert.equal(mixed.fiber_g, 0);
  assert.equal(mixed.fiber_unknown, true);
  const known = totalNutrients([{ kcal: 10, protein_g: 1, carbs_g: 1, fat_g: 1, fiber_g: 0 }]);
  assert.equal(known.fiber_g, 0);
  assert.equal(known.fiber_unknown, false);
});

test("target suggestion uses Mifflin-St Jeor, protein per kilogram, and 14 g fiber per 1000 kcal", () => {
  const targets = suggestTargets({
    sex: "female",
    age: 34,
    heightCm: 168,
    weightKg: 64,
    activity: "mostly seated",
    goal: "maintain",
  });
  assert.equal(targets.kcal, 1631);
  assert.equal(targets.protein_g, 115.2);
  assert.equal(targets.fiber_g, 22.8);
  assert.ok(targets.protein_g >= 1.6 * 64 && targets.protein_g <= 2.2 * 64);
});

test("USDA and Open Food Facts keep a missing fiber null", () => {
  const usda = parseUsdaFoods({
    foods: [
      {
        fdcId: 1,
        description: "Banana",
        dataType: "Foundation",
        servingSize: 118,
        servingSizeUnit: "g",
        foodNutrients: [
          { nutrientId: 1008, value: 89 },
          { nutrientId: 1003, value: 1.1 },
          { nutrientId: 1005, value: 22.8 },
          { nutrientId: 1004, value: 0.3 },
        ],
      },
    ],
  });
  assert.equal(usda[0].per100g?.fiber_g, null);
  assert.equal(usda[0].perServing?.fiber_g, null);
  const off = parseOpenFoodFacts(
    { product: { product_name: "Yogurt", nutriments: { "energy-kcal_100g": 100, proteins_100g: 10, carbohydrates_100g: 4, fat_100g: 0 } } },
    "0000000000000",
  );
  assert.equal(off?.per100g?.fiber_g, null);
});

test("auth hides the allow list, then signs in only an invited address", async () => {
  resetRateLimit();
  const store = new MemoryAbblStore();
  await store.allow("kate@example.com");
  const sent: { email: string; code: string }[] = [];
  const server = await listen(store, sent);
  try {
    const hidden = await json(await fetch(`${server.base}/api/abbl/v1/auth/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "nope@example.com" }) }));
    const invited = await json(await fetch(`${server.base}/api/abbl/v1/auth/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "Kate@example.com" }) }));
    assert.equal(hidden.status, 200);
    assert.deepEqual(hidden.body, invited.body);
    assert.deepEqual(sent.map((item) => item.email), ["kate@example.com"]);
    const bad = await json(await fetch(`${server.base}/api/abbl/v1/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "kate@example.com", code: "000000" }) }));
    assert.equal(bad.status, 401);
    const ok = await json(await fetch(`${server.base}/api/abbl/v1/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "kate@example.com", code: sent[0].code }) }));
    assert.equal(ok.status, 200);
    assert.equal((ok.body.user as { email: string; admin: boolean }).email, "kate@example.com");
    assert.equal((ok.body.user as { admin: boolean }).admin, false);
    const me = await json(await fetch(`${server.base}/api/abbl/v1/me`, { headers: { Authorization: `Bearer ${ok.body.token}` } }));
    assert.equal(me.status, 200);
  } finally {
    await server.close();
  }
});

test("sign-in is 503 for everyone when email is not configured", async () => {
  resetRateLimit();
  const store = new MemoryAbblStore();
  await store.allow("kate@example.com");
  const server = await listen(store, [], false);
  try {
    const a = await json(await fetch(`${server.base}/api/abbl/v1/auth/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "kate@example.com" }) }));
    const b = await json(await fetch(`${server.base}/api/abbl/v1/auth/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "nope@example.com" }) }));
    assert.equal(a.status, 503);
    assert.deepEqual(a.body, b.body);
  } finally {
    await server.close();
  }
});

test("users cannot read each other, recipes scale, and sharing copies", async () => {
  resetRateLimit();
  process.env.ABBL_ADMIN_EMAIL = "brandon@example.com";
  const store = new MemoryAbblStore();
  await store.allow("brandon@example.com");
  await store.allow("kate@example.com");
  const sent: { email: string; code: string }[] = [];
  const server = await listen(store, sent);
  const auth = async (email: string) => {
    await fetch(`${server.base}/api/abbl/v1/auth/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    const code = [...sent].reverse().find((item) => item.email === email)?.code;
    const verified = await json(await fetch(`${server.base}/api/abbl/v1/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, code }) }));
    return { token: String(verified.body.token), id: String((verified.body.user as { id: string }).id) };
  };
  try {
    const brandon = await auth("brandon@example.com");
    const kate = await auth("kate@example.com");
    const created = await json(
      await fetch(`${server.base}/api/abbl/v1/recipes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kate.token}` },
        body: JSON.stringify({
          name: "Oat bowl",
          servings: 4,
          yieldGrams: 400,
          ingredients: [oats, { ...oats, name: "Berries", nutrients: { ...oats.nutrients, fiber_g: null, kcal: 40 } }],
        }),
      }),
    );
    assert.equal(created.status, 201);
    const recipe = created.body.recipe as { id: string; totals: { kcal: number; fiber_g: number | null; fiber_unknown: boolean }; perServing: { kcal: number } };
    assert.equal(recipe.totals.kcal, 240);
    assert.equal(recipe.totals.fiber_g, 5);
    assert.equal(recipe.totals.fiber_unknown, true);
    assert.equal(recipe.perServing.kcal, 60);
    const hidden = await json(await fetch(`${server.base}/api/abbl/v1/recipes/${recipe.id}`, { headers: { Authorization: `Bearer ${brandon.token}` } }));
    assert.equal(hidden.status, 404);
    const logged = await json(
      await fetch(`${server.base}/api/abbl/v1/meals`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kate.token}` },
        body: JSON.stringify({ date: "2026-11-14", time: "08:00", recipeId: recipe.id, servings: 2 }),
      }),
    );
    assert.equal((logged.body.meal as { totals: { kcal: number } }).totals.kcal, 120);
    const byGrams = await json(
      await fetch(`${server.base}/api/abbl/v1/meals`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kate.token}` },
        body: JSON.stringify({ date: "2026-11-14", time: "12:00", recipeId: recipe.id, grams: 100 }),
      }),
    );
    assert.equal((byGrams.body.meal as { totals: { kcal: number } }).totals.kcal, 60);
    await fetch(`${server.base}/api/abbl/v1/recipes/${recipe.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${kate.token}` },
      body: JSON.stringify({ name: "Oat bowl", servings: 4, yieldGrams: 400, ingredients: [{ ...oats, nutrients: { ...oats.nutrients, kcal: 999 } }] }),
    });
    const day = await json(await fetch(`${server.base}/api/abbl/v1/days/2026-11-14`, { headers: { Authorization: `Bearer ${kate.token}` } }));
    const meals = day.body.meals as { totals: { kcal: number } }[];
    assert.deepEqual(meals.map((meal) => meal.totals.kcal).sort((a, b) => a - b), [60, 120]);
    const kateDay = await json(await fetch(`${server.base}/api/abbl/v1/days/2026-11-14`, { headers: { Authorization: `Bearer ${brandon.token}` } }));
    assert.equal((kateDay.body.meals as unknown[]).length, 0);
    const refused = await json(
      await fetch(`${server.base}/api/abbl/v1/recipes/${recipe.id}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kate.token}` },
        body: JSON.stringify({ toSteady: true }),
      }),
    );
    assert.equal(refused.status, 403);
    const shared = await json(
      await fetch(`${server.base}/api/abbl/v1/recipes/${recipe.id}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kate.token}` },
        body: JSON.stringify({ toUserId: brandon.id }),
      }),
    );
    assert.equal(shared.status, 201);
    const brandonList = await json(await fetch(`${server.base}/api/abbl/v1/recipes`, { headers: { Authorization: `Bearer ${brandon.token}` } }));
    assert.equal((brandonList.body.recipes as { id: string }[])[0].id === recipe.id, false);
    const favorite = await json(
      await fetch(`${server.base}/api/abbl/v1/recipes/${(brandonList.body.recipes as { id: string }[])[0].id}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${brandon.token}` },
        body: JSON.stringify({ toSteady: true }),
      }),
    );
    assert.equal(favorite.status, 201);
    assert.equal("fiber_g" in (favorite.body.favorite as object), false);
    assert.equal(store.favorites.length, 1);
  } finally {
    delete process.env.ABBL_ADMIN_EMAIL;
    await server.close();
  }
});

test("removing a user revokes access and keeps their recipes", async () => {
  resetRateLimit();
  process.env.ABBL_ADMIN_EMAIL = "brandon@example.com";
  const store = new MemoryAbblStore();
  await store.allow("brandon@example.com");
  await store.allow("kate@example.com");
  const sent: { email: string; code: string }[] = [];
  const server = await listen(store, sent);
  try {
    await fetch(`${server.base}/api/abbl/v1/auth/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "brandon@example.com" }) });
    await fetch(`${server.base}/api/abbl/v1/auth/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "kate@example.com" }) });
    const brandon = await json(await fetch(`${server.base}/api/abbl/v1/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "brandon@example.com", code: sent.find((item) => item.email === "brandon@example.com")?.code }) }));
    const kate = await json(await fetch(`${server.base}/api/abbl/v1/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "kate@example.com", code: sent.find((item) => item.email === "kate@example.com")?.code }) }));
    const kateId = (kate.body.user as { id: string }).id;
    await fetch(`${server.base}/api/abbl/v1/recipes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${kate.body.token}` },
      body: JSON.stringify({ name: "Soup", servings: 2, ingredients: [oats] }),
    });
    const removed = await json(await fetch(`${server.base}/api/abbl/v1/admin/users/${kateId}`, { method: "DELETE", headers: { Authorization: `Bearer ${brandon.body.token}` } }));
    assert.equal(removed.status, 200);
    const blocked = await json(await fetch(`${server.base}/api/abbl/v1/me`, { headers: { Authorization: `Bearer ${kate.body.token}` } }));
    assert.equal(blocked.status, 401);
    assert.equal(store.recipes.size, 1);
    await fetch(`${server.base}/api/abbl/v1/auth/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "kate@example.com" }) });
    const again = await json(await fetch(`${server.base}/api/abbl/v1/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "kate@example.com", code: [...sent].reverse().find((item) => item.email === "kate@example.com")?.code }) }));
    assert.equal(again.status, 403);
  } finally {
    delete process.env.ABBL_ADMIN_EMAIL;
    await server.close();
  }
});

test("ABBL does not call Nightscout", () => {
  const files = readdirSync(new URL("../src/server/abbl/", import.meta.url));
  for (const file of files) {
    const source = readFileSync(new URL(`../src/server/abbl/${file}`, import.meta.url), "utf8");
    assert.equal(/nightscout/i.test(source), false, file);
  }
});
