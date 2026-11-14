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

const SETUP = "setup-secret-for-tests";

function listen(store: MemoryAbblStore, now: () => Date = () => new Date("2026-11-14T18:00:00.000Z")) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(
    "/api/abbl/v1",
    createAbblRouter({
      store,
      now,
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

async function redeem(base: string, code: string, name?: string) {
  return json(
    await fetch(`${base}/api/abbl/v1/auth/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(name ? { code, name } : { code }),
    }),
  );
}

test("the setup code creates the admin once, and other codes stay invalid", async () => {
  resetRateLimit();
  process.env.ABBL_ADMIN_SETUP_CODE = SETUP;
  const store = new MemoryAbblStore();
  const server = await listen(store);
  try {
    const bad = await redeem(server.base, "nope-nope-nope");
    assert.equal(bad.status, 401);
    const first = await redeem(server.base, SETUP, "Brandon");
    const second = await redeem(server.base, `  ${SETUP}  `);
    assert.equal(first.status, 200);
    assert.equal((first.body.user as { admin: boolean; name: string }).admin, true);
    assert.equal((first.body.user as { name: string }).name, "Brandon");
    assert.equal((second.body.user as { id: string }).id, (first.body.user as { id: string }).id);
    assert.equal(store.users.size, 1);
    const me = await json(await fetch(`${server.base}/api/abbl/v1/me`, { headers: { Authorization: `Bearer ${first.body.token}` } }));
    assert.equal(me.status, 200);
  } finally {
    delete process.env.ABBL_ADMIN_SETUP_CODE;
    await server.close();
  }
});

test("redeem is rate-limited per IP", async () => {
  resetRateLimit();
  const server = await listen(new MemoryAbblStore());
  try {
    for (let i = 0; i < 8; i += 1) {
      const attempt = await redeem(server.base, `bad-${i}`);
      assert.equal(attempt.status, 401);
    }
    const limited = await redeem(server.base, "bad-last");
    assert.equal(limited.status, 429);
  } finally {
    await server.close();
  }
});

test("invite codes are single-use, hashed, and can sign the same user in again", async () => {
  resetRateLimit();
  process.env.ABBL_ADMIN_SETUP_CODE = SETUP;
  const store = new MemoryAbblStore();
  const server = await listen(store);
  try {
    const admin = await redeem(server.base, SETUP, "Brandon");
    const created = await json(
      await fetch(`${server.base}/api/abbl/v1/admin/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.body.token}` },
        body: JSON.stringify({ name: "Kate", email: "kate@example.com" }),
      }),
    );
    const code = String(created.body.code);
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}(?:-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}){2}$/);
    const listed = await json(await fetch(`${server.base}/api/abbl/v1/admin/invites`, { headers: { Authorization: `Bearer ${admin.body.token}` } }));
    const listedText = JSON.stringify(listed.body);
    assert.equal(listedText.includes(code), false);
    assert.equal(listedText.includes("codeHash"), false);
    assert.equal(store.invites.some((invite) => invite.codeHash === code), false);
    const kate = await redeem(server.base, code.toLowerCase());
    assert.equal((kate.body.user as { name: string; admin: boolean; email: string }).name, "Kate");
    assert.equal((kate.body.user as { admin: boolean }).admin, false);
    assert.equal((kate.body.user as { email: string }).email, "kate@example.com");
    const spent = await redeem(server.base, code);
    assert.equal(spent.status, 401);
    const phone = await json(
      await fetch(`${server.base}/api/abbl/v1/admin/users/${(kate.body.user as { id: string }).id}/invite`, {
        method: "POST",
        headers: { Authorization: `Bearer ${admin.body.token}` },
      }),
    );
    const again = await redeem(server.base, String(phone.body.code));
    assert.equal((again.body.user as { id: string }).id, (kate.body.user as { id: string }).id);
  } finally {
    delete process.env.ABBL_ADMIN_SETUP_CODE;
    await server.close();
  }
});

test("users cannot read each other, recipes scale, and sharing copies", async () => {
  resetRateLimit();
  process.env.ABBL_ADMIN_SETUP_CODE = SETUP;
  const store = new MemoryAbblStore();
  const server = await listen(store);
  try {
    const admin = await redeem(server.base, SETUP, "Brandon");
    const invited = await json(
      await fetch(`${server.base}/api/abbl/v1/admin/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.body.token}` },
        body: JSON.stringify({ name: "Kate" }),
      }),
    );
    const kateSession = await redeem(server.base, String(invited.body.code));
    const brandon = { token: String(admin.body.token), id: String((admin.body.user as { id: string }).id) };
    const kate = { token: String(kateSession.body.token), id: String((kateSession.body.user as { id: string }).id) };
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
    delete process.env.ABBL_ADMIN_SETUP_CODE;
    await server.close();
  }
});

test("removing a user revokes access and keeps their recipes", async () => {
  resetRateLimit();
  process.env.ABBL_ADMIN_SETUP_CODE = SETUP;
  const store = new MemoryAbblStore();
  const server = await listen(store);
  try {
    const brandon = await redeem(server.base, SETUP, "Brandon");
    const invited = await json(
      await fetch(`${server.base}/api/abbl/v1/admin/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${brandon.body.token}` },
        body: JSON.stringify({ name: "Kate" }),
      }),
    );
    const kate = await redeem(server.base, String(invited.body.code));
    const kateId = (kate.body.user as { id: string }).id;
    const fresh = await json(
      await fetch(`${server.base}/api/abbl/v1/admin/users/${kateId}/invite`, {
        method: "POST",
        headers: { Authorization: `Bearer ${brandon.body.token}` },
      }),
    );
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
    const again = await redeem(server.base, String(fresh.body.code));
    assert.equal(again.status, 403);
    const reinvite = await json(
      await fetch(`${server.base}/api/abbl/v1/admin/users/${kateId}/invite`, {
        method: "POST",
        headers: { Authorization: `Bearer ${brandon.body.token}` },
      }),
    );
    assert.equal(reinvite.status, 400);
  } finally {
    delete process.env.ABBL_ADMIN_SETUP_CODE;
    await server.close();
  }
});

test("an unused invite can be revoked", async () => {
  resetRateLimit();
  process.env.ABBL_ADMIN_SETUP_CODE = SETUP;
  const server = await listen(new MemoryAbblStore());
  try {
    const admin = await redeem(server.base, SETUP);
    const created = await json(
      await fetch(`${server.base}/api/abbl/v1/admin/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.body.token}` },
        body: JSON.stringify({ name: "Sam" }),
      }),
    );
    const id = (created.body.invite as { id: string }).id;
    const revoked = await json(await fetch(`${server.base}/api/abbl/v1/admin/invites/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${admin.body.token}` } }));
    assert.equal(revoked.status, 200);
    const attempt = await redeem(server.base, String(created.body.code));
    assert.equal(attempt.status, 401);
  } finally {
    delete process.env.ABBL_ADMIN_SETUP_CODE;
    await server.close();
  }
});

test("an invite expires after 7 days", async () => {
  resetRateLimit();
  process.env.ABBL_ADMIN_SETUP_CODE = SETUP;
  let clock = Date.parse("2026-11-14T18:00:00.000Z");
  const server = await listen(new MemoryAbblStore(), () => new Date(clock));
  try {
    const admin = await redeem(server.base, SETUP);
    const created = await json(
      await fetch(`${server.base}/api/abbl/v1/admin/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.body.token}` },
        body: JSON.stringify({ name: "Sam" }),
      }),
    );
    clock += 8 * 24 * 60 * 60 * 1000;
    const attempt = await redeem(server.base, String(created.body.code));
    assert.equal(attempt.status, 401);
  } finally {
    delete process.env.ABBL_ADMIN_SETUP_CODE;
    await server.close();
  }
});

test("ABBL does not call Nightscout or send email", () => {
  const files = readdirSync(new URL("../src/server/abbl/", import.meta.url));
  for (const file of files) {
    const source = readFileSync(new URL(`../src/server/abbl/${file}`, import.meta.url), "utf8");
    assert.equal(/nightscout/i.test(source), false, file);
    assert.equal(/resend/i.test(source), false, file);
    assert.equal(source.includes("ABBL_ADMIN_EMAIL"), false, file);
  }
});
