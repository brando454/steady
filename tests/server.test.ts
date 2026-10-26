import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseMealEstimate } from "../src/server/ai";
import { glucoseStatusText } from "../src/shared/glucose";
import {
  clearGlucoseCache,
  nightscoutEntriesUrl,
  normalizeNightscoutBase,
  normalizeNightscoutToken,
  parseNightscout,
  readGlucose,
  scrubSecret,
} from "../src/server/nightscout";
import { connectionConfig } from "../src/server/pg-config";
import { bearerToken, resetRateLimit, signSession, verifySession, rateLimit } from "../src/server/auth";

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

test("a bearer header carries the native session token", () => {
  assert.equal(bearerToken("Bearer abc.def"), "abc.def");
  assert.equal(bearerToken("bearer abc.def"), "abc.def");
  assert.equal(bearerToken("Basic abc"), "");
  assert.equal(bearerToken(undefined), "");
  const source = readFileSync(new URL("../src/server/app.ts", import.meta.url), "utf8");
  assert.match(source, /res\.json\(\{ ok: true, token \}\)/);
  assert.match(source, /bearerToken\(req\.get\("authorization"\)\)/);
  assert.match(source, /app\.get\("\/api\/program"/);
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
  const missing = await readGlucose(fetch, now);
  assert.equal(missing.available, false);
  if (!missing.available) {
    assert.equal(missing.reason, "not_configured");
    assert.equal(missing.detail, "NIGHTSCOUT_URL and NIGHTSCOUT_TOKEN");
    assert.equal(glucoseStatusText(missing), "NIGHTSCOUT_URL and NIGHTSCOUT_TOKEN aren't set on the server");
  }

  process.env.NIGHTSCOUT_URL = "https://example.test";
  process.env.NIGHTSCOUT_TOKEN = "token";
  clearGlucoseCache();
  let called = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    called = String(input instanceof URL ? `${input.href} ${init?.method}` : input);
    return new Response(JSON.stringify([{ sgv: 141, direction: "FortyFiveUp", date: now }]), { status: 200 });
  };
  const live = await readGlucose(fetchImpl, now);
  assert.equal(live.available, true);
  assert.equal(glucoseStatusText(live), "141 mg/dL · just now");
  assert.match(called, /method=GET| GET$/);
  assert.match(called, /count=1/);
  assert.match(called, /token=token/);
  if (previousUrl == null) delete process.env.NIGHTSCOUT_URL;
  else process.env.NIGHTSCOUT_URL = previousUrl;
  if (previousToken == null) delete process.env.NIGHTSCOUT_TOKEN;
  else process.env.NIGHTSCOUT_TOKEN = previousToken;
  clearGlucoseCache();
});

test("Nightscout explains failures and normalizes the site URL", async () => {
  assert.equal(normalizeNightscoutBase("  https://example.test/  "), "https://example.test");
  assert.equal(normalizeNightscoutBase("https://example.test/api/v1"), "https://example.test");
  assert.equal(normalizeNightscoutBase("https://example.test/api/v1/entries.json?token=abc&count=1"), "https://example.test");
  assert.equal(normalizeNightscoutBase("example.test/ns/api/v1/"), "https://example.test/ns");
  assert.equal(normalizeNightscoutBase("http://localhost:1337/"), "http://localhost:1337");
  assert.equal(normalizeNightscoutToken(" token=abc&count=1 "), "abc");
  assert.equal(normalizeNightscoutToken("?token=abc"), "abc");
  assert.equal(normalizeNightscoutToken("plain-token"), "plain-token");

  const cleaned = nightscoutEntriesUrl(" example.test/api/v1?token=nope ", "token=real-token");
  assert.equal(cleaned.origin, "https://example.test");
  assert.equal(cleaned.pathname, "/api/v1/entries.json");
  assert.equal(cleaned.searchParams.get("token"), "real-token");
  assert.equal(cleaned.searchParams.get("count"), "1");

  const previousUrl = process.env.NIGHTSCOUT_URL;
  const previousToken = process.env.NIGHTSCOUT_TOKEN;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  const now = Date.parse("2026-10-24T15:00:00.000Z");
  try {
    process.env.NIGHTSCOUT_URL = "https://example.test";
    delete process.env.NIGHTSCOUT_TOKEN;
    clearGlucoseCache();
    const noToken = await readGlucose(fetch, now);
    assert.deepEqual(noToken, { available: false, reason: "not_configured", detail: "NIGHTSCOUT_TOKEN" });
    assert.equal(glucoseStatusText(noToken), "NIGHTSCOUT_TOKEN isn't set on the server");

    delete process.env.NIGHTSCOUT_URL;
    process.env.NIGHTSCOUT_TOKEN = "secret";
    clearGlucoseCache();
    const noUrl = await readGlucose(fetch, now);
    assert.equal(!noUrl.available && noUrl.detail, "NIGHTSCOUT_URL");
    assert.equal(glucoseStatusText(noUrl), "NIGHTSCOUT_URL isn't set on the server");

    process.env.NIGHTSCOUT_URL = "example.test/api/v1?token=secret";
    process.env.NIGHTSCOUT_TOKEN = "token=secret";
    clearGlucoseCache();
    let calls = 0;
    const httpFail: typeof fetch = async (input, init) => {
      calls += 1;
      assert.equal(init?.method, "GET");
      const href = String(input instanceof URL ? input.href : input);
      assert.match(href, /^https:\/\/example\.test\/api\/v1\/entries\.json\?/);
      assert.match(href, /token=secret/);
      return new Response("no", { status: 401 });
    };
    const http = await readGlucose(httpFail, now);
    assert.equal(!http.available && http.reason, "http_401");
    assert.equal(glucoseStatusText(http), "Nightscout returned HTTP 401");
    await readGlucose(httpFail, now + 1000);
    assert.equal(calls, 1);
    await readGlucose(httpFail, now + 16_000);
    assert.equal(calls, 2);

    clearGlucoseCache();
    const timedOut = await readGlucose(async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    }, now);
    assert.equal(!timedOut.available && timedOut.reason, "timeout");
    assert.equal(glucoseStatusText(timedOut), "Nightscout timed out");

    clearGlucoseCache();
    const refused = await readGlucose(async () => {
      throw Object.assign(new Error("connect failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    }, now);
    assert.equal(!refused.available && refused.reason, "network");
    assert.equal(!refused.available && refused.detail, "ECONNREFUSED");
    assert.equal(glucoseStatusText(refused), "Couldn't reach Nightscout (ECONNREFUSED)");

    clearGlucoseCache();
    const leaked = await readGlucose(async () => {
      const cause = new Error("failed https://example.test/api/v1/entries.json?token=secret&count=1");
      throw new Error("network down", { cause });
    }, now);
    assert.equal(!leaked.available && leaked.reason, "network");
    assert.equal(leaked.available, false);
    if (!leaked.available) {
      assert.equal(leaked.detail?.includes("secret"), false);
      assert.equal(leaked.detail?.includes("token="), false);
      assert.match(leaked.detail ?? "", /example\.test\/api\/v1\/entries\.json/);
    }

    clearGlucoseCache();
    const bad = await readGlucose(async () => new Response(JSON.stringify([{ sgv: "nope" }]), { status: 200 }), now);
    assert.equal(!bad.available && bad.reason, "bad_payload");
    assert.equal(glucoseStatusText(bad), "Nightscout's reply wasn't a reading");

    clearGlucoseCache();
    const stale = await readGlucose(
      async () => new Response(JSON.stringify([{ sgv: 142, direction: "Flat", date: now - 16 * 60_000 }]), { status: 200 }),
      now,
    );
    assert.equal(stale.available, false);
    if (!stale.available) {
      assert.equal(stale.reason, "stale");
      assert.equal(stale.mgdl, 142);
      assert.equal(stale.minutesAgo, 16);
    }
    assert.equal(glucoseStatusText(stale), "142 mg/dL · 16 min ago. Older than 15 minutes.");

    const scrubbed = scrubSecret("token=secret in https://example.test/x?token=secret", "secret");
    assert.equal(scrubbed.includes("secret"), false);
  } finally {
    console.warn = originalWarn;
    if (previousUrl == null) delete process.env.NIGHTSCOUT_URL;
    else process.env.NIGHTSCOUT_URL = previousUrl;
    if (previousToken == null) delete process.env.NIGHTSCOUT_TOKEN;
    else process.env.NIGHTSCOUT_TOKEN = previousToken;
    clearGlucoseCache();
  }
  assert.equal(warnings.some((line) => line.includes("secret")), false);
  assert.equal(warnings.some((line) => line.includes("?token=")), false);
  assert.equal(warnings.filter((line) => line.startsWith("Nightscout: http_401")).length, 1);
});
