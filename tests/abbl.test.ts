import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import express from "express";
import { resetRateLimit } from "../src/server/auth";
import { MemoryAbblStore } from "../src/server/abbl/memory";
import { parseMacro, readIngredient, scaleIngredient, totalNutrients } from "../src/server/abbl/nutrients";
import { estimatePhotos, fillNutrition, helpRecipe, parseEstimate, parseLabel } from "../src/server/abbl/vision";
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

function listen(store: MemoryAbblStore, now: () => Date = () => new Date("2026-11-14T18:00:00.000Z"), fetchImpl?: typeof fetch) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(
    "/api/abbl/v1",
    createAbblRouter({
      store,
      now,
      fetch: fetchImpl,
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

test("label amounts accept less-than, trace, and units", () => {
  assert.equal(parseMacro("<1"), 0.5);
  assert.equal(parseMacro("<1g"), 0.5);
  assert.equal(parseMacro("< 1 g"), 0.5);
  assert.equal(parseMacro("<0.5"), 0);
  assert.equal(parseMacro("<0.5g"), 0);
  assert.equal(parseMacro("trace"), 0);
  assert.equal(parseMacro("Trace"), 0);
  assert.equal(parseMacro("0.5g"), 0.5);
  assert.equal(parseMacro("3.5 g"), 3.5);
  assert.equal(parseMacro(3.5), 3.5);
  assert.equal(parseMacro("70 kcal"), 70);
  assert.equal(parseMacro("70cal"), 70);
  assert.equal(parseMacro("500mg"), 0.5);
  assert.equal(parseMacro("<2g"), 1);
  assert.equal(parseMacro("0g"), 0);
  assert.equal(parseMacro("not listed"), null);
});

test("a Kellogg's cracker label with protein <1g still scans", async () => {
  resetRateLimit();
  process.env.ABBL_ADMIN_SETUP_CODE = SETUP;
  process.env.AI_API_KEY = "test-key";
  const label = {
    servingSize: "5 crackers (15g)",
    servingsPerContainer: 5,
    nutrients: { kcal: 70, fat_g: "3.5 g", carbs_g: "10g", fiber_g: "0g", protein_g: "<1g" },
  };
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(label) } }] }), { status: 200 });
  const server = await listen(new MemoryAbblStore(), undefined, fetchImpl);
  try {
    const admin = await redeem(server.base, SETUP);
    const scanned = await json(
      await fetch(`${server.base}/api/abbl/v1/label-scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.body.token}` },
        body: JSON.stringify({ photo: "/9j/4AAQ" }),
      }),
    );
    assert.equal(scanned.status, 200);
    assert.equal(scanned.body.servingSize, "5 crackers (15g)");
    assert.deepEqual(scanned.body.nutrients, { kcal: 70, protein_g: 0.5, carbs_g: 10, fat_g: 3.5, fiber_g: 0 });
    const partial = parseLabel(JSON.stringify({ nutrients: { kcal: 70, protein_g: "lots", carbs_g: "10g", fat_g: "3.5g", fiber_g: null } }));
    assert.equal(partial.nutrients.protein_g, null);
    assert.equal(partial.nutrients.fiber_g, null);
    assert.equal(partial.nutrients.kcal, 70);
    assert.throws(() => parseLabel(JSON.stringify({ nutrients: { kcal: "nope", protein_g: "lots", fiber_g: "" } })), /didn't come back/);
  } finally {
    delete process.env.ABBL_ADMIN_SETUP_CODE;
    delete process.env.AI_API_KEY;
    await server.close();
  }
});

test("a photo can return every ingredient, including a labeled box", () => {
  const zeros = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: null };
  const real = { kcal: 100, protein_g: 10, carbs_g: 8, fat_g: 2, fiber_g: 1 };
  const parsed = parseEstimate(
    JSON.stringify({
      ingredients: [
        { photoIndex: 0, name: "chicken breast, raw", grams: 450, nutrients: real, confidence: 0.7, uncertainty: 0.4 },
        { photoIndex: 0, name: "onion, raw", grams: 150, nutrients: real, confidence: 0.6 },
        { photoIndex: 0, name: "potatoes, raw", grams: 300, nutrients: real, confidence: 0.6 },
        { photoIndex: 0, name: "carrots, raw", grams: 120, nutrients: real, confidence: 0.6 },
        { photoIndex: 0, name: "S&B Golden Curry sauce mix, 92 g box", grams: 92, nutrients: zeros, confidence: 0.9 },
        { photoIndex: 1, name: "should be dropped", grams: 10, nutrients: real },
      ],
    }),
    1,
  );
  assert.deepEqual(
    parsed.map((item) => item.name),
    ["chicken breast, raw", "onion, raw", "potatoes, raw", "carrots, raw", "S&B Golden Curry sauce mix, 92 g box"],
  );
  assert.ok(parsed.every((item) => item.photoIndex === 0));
  assert.equal(parsed[0].uncertainty, 0.4);
  assert.equal(parsed[1].uncertainty, undefined);
  assert.equal(parsed[4].nutrients, null);
});

test("all-zero nutrients are filled from USDA, and a miss is not stored as zero", async () => {
  const per100 = { kcal: 120, protein_g: 22.5, carbs_g: 0, fat_g: 2.6, fiber_g: null as number | null };
  const blank = { name: "chicken breast, raw", grams: 200, nutrients: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: null }, per100g: null };
  const filled = await fillNutrition(blank, async () => per100);
  assert.deepEqual(filled.nutrients, { kcal: 240, protein_g: 45, carbs_g: 0, fat_g: 5.2, fiber_g: null });
  assert.equal(filled.nutrition_missing, undefined);
  const knownFiber = await fillNutrition(blank, async () => ({ ...per100, fiber_g: 0 }));
  assert.equal(knownFiber.nutrients?.fiber_g, 0);
  const fromModel = await fillNutrition(
    { ...blank, grams: 92, nutrients: null, per100g: { kcal: 374, protein_g: 6, carbs_g: 56, fat_g: 13, fiber_g: 3.3 } },
    async () => {
      throw new Error("lookup should not run");
    },
  );
  assert.equal(fromModel.nutrients?.kcal, 344.1);
  assert.equal(fromModel.nutrients?.fiber_g, 3);
  const missing = await fillNutrition(blank, async () => null);
  assert.equal(missing.nutrients, null);
  assert.equal(missing.nutrition_missing, true);

  process.env.AI_API_KEY = "test-key";
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: unknown }> };
    const content = body.messages[0].content as Array<{ image_url?: { detail?: string } }>;
    const image = content.find((part) => part.image_url);
    seen.push(image?.image_url?.detail ?? "");
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                ingredients: [
                  { photoIndex: 0, name: "chicken breast, raw", grams: 200, nutrients: blank.nutrients, confidence: 0.5 },
                  { photoIndex: 0, name: "S&B Golden Curry sauce mix, 92 g box", grams: 92, nutrients: { kcal: 344, protein_g: 5.5, carbs_g: 52, fat_g: 12, fiber_g: 3 }, confidence: 0.9 },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  };
  const estimated = await estimatePhotos(["/9j/4AAQ"], null, fetchImpl, async () => per100);
  assert.deepEqual(seen, ["high"]);
  assert.equal(estimated.length, 2);
  assert.equal(estimated[0].nutrients?.kcal, 240);
  assert.equal(estimated[0].nutrients?.fiber_g, null);
  assert.equal(estimated[1].nutrients?.fiber_g, 3);
  assert.equal(estimated[1].nutrition_missing, undefined);
  const helped = await helpRecipe("chicken and curry", undefined, async () => {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ ingredients: [{ name: "chicken breast, raw", grams: 100, nutrients: blank.nutrients }], questions: [] }) } }],
      }),
      { status: 200 },
    );
  }, async () => null);
  assert.equal(helped.ingredients[0].nutrients, null);
  assert.equal(helped.ingredients[0].nutrition_missing, true);
  delete process.env.AI_API_KEY;
});

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

test("ingredient quantity and unit round trip, and grams stay the nutrition amount", async () => {
  const broth = {
    name: "Chicken broth",
    quantity: 3.5,
    unit: "cup",
    grams: 840,
    source: "ai",
    nutrients: { kcal: 59, protein_g: 4, carbs_g: 5, fat_g: 1.7, fiber_g: 0 },
  };
  const read = readIngredient(broth);
  assert.equal(read.quantity, 3.5);
  assert.equal(read.unit, "cup");
  const old = readIngredient({ name: "Oats", grams: 40, source: "manual", nutrients: broth.nutrients });
  assert.equal(old.quantity, null);
  assert.equal(old.unit, null);
  const scaled = scaleIngredient(read, 0.5);
  assert.equal(scaled.quantity, 1.8);
  assert.equal(scaled.grams, 420);
  assert.equal(scaled.unit, "cup");
  assert.equal(scaled.nutrients.kcal, 29.5);
  const scaledOld = scaleIngredient(old, 2);
  assert.equal(scaledOld.quantity, null);
  assert.equal(scaledOld.unit, null);
  assert.equal(scaledOld.grams, 80);
  assert.throws(() => readIngredient({ ...broth, unit: "lb" }), /unit looks off/);
  assert.throws(() => readIngredient({ ...broth, quantity: 0 }), /quantity looks off/);
  assert.throws(() => readIngredient({ ...broth, grams: 0 }), /grams looks off/);

  resetRateLimit();
  process.env.ABBL_ADMIN_SETUP_CODE = SETUP;
  const server = await listen(new MemoryAbblStore());
  try {
    const admin = await redeem(server.base, SETUP, "Brandon");
    const created = await json(
      await fetch(`${server.base}/api/abbl/v1/recipes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.body.token}` },
        body: JSON.stringify({ name: "Soup", servings: 2, ingredients: [broth, { name: "Oats", grams: 40, nutrients: broth.nutrients }] }),
      }),
    );
    assert.equal(created.status, 201);
    const ingredients = (created.body.recipe as { ingredients: { quantity: number | null; unit: string | null; grams: number }[] }).ingredients;
    assert.deepEqual(
      ingredients.map((item) => ({ quantity: item.quantity, unit: item.unit, grams: item.grams })),
      [
        { quantity: 3.5, unit: "cup", grams: 840 },
        { quantity: null, unit: null, grams: 40 },
      ],
    );
    const logged = await json(
      await fetch(`${server.base}/api/abbl/v1/meals`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.body.token}` },
        body: JSON.stringify({ date: "2026-11-14", time: "12:00", recipeId: (created.body.recipe as { id: string }).id, servings: 1 }),
      }),
    );
    const items = (logged.body.meal as { items: { quantity: number | null; unit: string | null; grams: number }[] }).items;
    assert.equal(items[0].quantity, 1.8);
    assert.equal(items[0].unit, "cup");
    assert.equal(items[0].grams, 420);
    assert.equal(items[1].quantity, null);
    const bad = await json(
      await fetch(`${server.base}/api/abbl/v1/recipes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.body.token}` },
        body: JSON.stringify({ name: "Nope", servings: 1, ingredients: [{ ...broth, unit: "gallon" }] }),
      }),
    );
    assert.equal(bad.status, 400);
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
