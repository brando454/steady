import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseMealEstimate } from "../src/server/ai";
import { clearGlucoseCache, nightscoutEntriesUrl, parseNightscout, readGlucose } from "../src/server/nightscout";
import { connectionConfig } from "../src/server/pg-config";
import { resetRateLimit, signSession, verifySession, rateLimit } from "../src/server/auth";

test("session cookie lasts until it expires and rejects tampering", () => {
  const now = Date.parse("2026-10-24T12:00:00.000Z");
  const token = signSession("correct horse", now);
  assert.equal(verifySession(token, "correct horse", now + 1000), true);
  assert.equal(verifySession(token, "wrong", now + 1000), false);
  assert.equal(verifySession(`${token}x`, "correct horse", now), false);
  const [body] = token.split(".");
  assert.equal(verifySession(`${body}.aaaa`, "correct horse", now), false);
  assert.equal(verifySession(token, "correct horse", now + 366 * 24 * 60 * 60 * 1000), false);
});

test("login attempts are limited", () => {
  resetRateLimit();
  for (let i = 0; i < 8; i += 1) assert.equal(rateLimit("ip", 8, 1000, 0), true);
  assert.equal(rateLimit("ip", 8, 1000, 0), false);
  assert.equal(rateLimit("ip", 8, 1000, 2000), true);
});

test("database SSL follows the host", () => {
  assert.equal(Boolean(connectionConfig("postgres://steady:steady@localhost:5432/steady").ssl), false);
  assert.equal(Boolean(connectionConfig("postgres://u:p@dpg-abc-a/steady").ssl), false);
  assert.equal(
    Boolean(connectionConfig("postgres://u:p@dpg-abc.oregon-postgres.render.com/steady").ssl),
    true,
  );
  assert.equal(Boolean(connectionConfig("postgres://u:p@example.com/steady?sslmode=require").ssl), true);
});

test("meal estimates accept JSON wrapped in prose", () => {
  const parsed = parseMealEstimate(`Here you go:\n{"name":"Chicken bowl","calories":740,"protein":"58","carbs":70,"fat":22}`);
  assert.deepEqual(parsed, { name: "Chicken bowl", calories: 740, protein: 58, carbs: 70, fat: 22 });
  assert.equal(parseMealEstimate("no json"), null);
  assert.equal(parseMealEstimate('{"name":"","calories":1,"protein":1,"carbs":1,"fat":1}'), null);
});

test("Nightscout is read with GET and hidden when it fails", async () => {
  const url = nightscoutEntriesUrl("https://example.test/", "secret-token");
  assert.equal(url.pathname, "/api/v1/entries.json");
  assert.equal(url.searchParams.get("count"), "1");
  assert.equal(url.searchParams.get("token"), "secret-token");

  const source = readFileSync(new URL("../src/server/nightscout.ts", import.meta.url), "utf8");
  assert.match(source, /method:\s*"GET"/);
  assert.doesNotMatch(source, /method:\s*"POST"/);
  assert.doesNotMatch(source, /method:\s*"PUT"/);
  assert.doesNotMatch(source, /method:\s*"PATCH"/);
  assert.doesNotMatch(source, /method:\s*"DELETE"/);

  const now = Date.parse("2026-10-24T15:00:00.000Z");
  const reading = parseNightscout([{ sgv: 118, direction: "Flat", date: now - 120_000 }], now);
  assert.equal(reading?.mgdl, 118);
  assert.equal(reading?.arrow, "→");
  assert.equal(reading?.minutesAgo, 2);

  const previousUrl = process.env.NIGHTSCOUT_URL;
  const previousToken = process.env.NIGHTSCOUT_TOKEN;
  delete process.env.NIGHTSCOUT_URL;
  delete process.env.NIGHTSCOUT_TOKEN;
  clearGlucoseCache();
  assert.deepEqual(await readGlucose(fetch), { available: false });

  process.env.NIGHTSCOUT_URL = "https://example.test";
  process.env.NIGHTSCOUT_TOKEN = "token";
  clearGlucoseCache();
  let called = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    called = String(input instanceof URL ? `${input.href} ${init?.method}` : input);
    return new Response(JSON.stringify([{ sgv: 141, direction: "FortyFiveUp", date: now }]), { status: 200 });
  };
  const live = await readGlucose(fetchImpl);
  assert.equal(live.available, true);
  assert.match(called, /method=GET| GET$/);
  assert.match(called, /count=1/);
  assert.match(called, /token=token/);
  if (previousUrl == null) delete process.env.NIGHTSCOUT_URL;
  else process.env.NIGHTSCOUT_URL = previousUrl;
  if (previousToken == null) delete process.env.NIGHTSCOUT_TOKEN;
  else process.env.NIGHTSCOUT_TOKEN = previousToken;
  clearGlucoseCache();
});
