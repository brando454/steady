import { glucoseStatusText } from "../shared/glucose";
import type { GlucoseDTO } from "../shared/types";

export { glucoseStatusText };

const TRENDS: Record<string, { arrow: string; label: string }> = {
  DoubleUp: { arrow: "↑↑", label: "Rising fast" },
  SingleUp: { arrow: "↑", label: "Rising" },
  FortyFiveUp: { arrow: "↗", label: "Rising slightly" },
  Flat: { arrow: "→", label: "Steady" },
  FortyFiveDown: { arrow: "↘", label: "Falling slightly" },
  SingleDown: { arrow: "↓", label: "Falling" },
  DoubleDown: { arrow: "↓↓", label: "Falling fast" },
  NONE: { arrow: "·", label: "No trend" },
  NOT_COMPUTABLE: { arrow: "·", label: "No trend" },
};

const CACHE_MS = 15_000;
const STALE_MS = 15 * 60_000;

export function normalizeNightscoutBase(input: string): string {
  let value = input.trim();
  if (!value) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v1(?:\/.*)?$/i, "").replace(/\/+$/, "");
  return `${url.origin}${path && path !== "/" ? path : ""}`;
}

export function normalizeNightscoutToken(input: string): string {
  let value = input.trim();
  value = value.replace(/^\??token\s*=\s*/i, "");
  const amp = value.indexOf("&");
  if (amp >= 0) value = value.slice(0, amp);
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep the raw token */
  }
  return value.trim();
}

export function nightscoutEntriesUrl(base: string, token: string): URL {
  const root = normalizeNightscoutBase(base);
  const url = new URL(`${root}/api/v1/entries.json`);
  url.searchParams.set("token", normalizeNightscoutToken(token));
  url.searchParams.set("count", "1");
  return url;
}

export function scrubSecret(text: string, token: string): string {
  let out = text;
  const secrets = [token, normalizeNightscoutToken(token)].filter((item) => item.length > 0);
  for (const secret of secrets) {
    out = out.split(secret).join("[redacted]");
    try {
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) out = out.split(encoded).join("[redacted]");
    } catch {
      /* the token was not a URI component */
    }
  }
  out = out.replace(/([?&])token=[^&\s]*/gi, "$1token=[redacted]");
  out = out.replace(/https?:\/\/\S+/gi, (match) => {
    const trimmed = match.replace(/[),.;]+$/, "");
    const tail = match.slice(trimmed.length);
    try {
      const url = new URL(trimmed);
      return `${url.origin}${url.pathname}${tail}`;
    } catch {
      return `${trimmed.split("?")[0]}${tail}`;
    }
  });
  return out.slice(0, 200);
}

export function parseNightscout(data: unknown, now = Date.now()): Extract<GlucoseDTO, { available: true }> | null {
  if (!Array.isArray(data) || !data[0] || typeof data[0] !== "object") return null;
  const row = data[0] as Record<string, unknown>;
  if (typeof row.sgv !== "number" || row.sgv < 20 || row.sgv > 500) return null;
  const direction = typeof row.direction === "string" ? row.direction : "NONE";
  const trend = TRENDS[direction] ?? { arrow: "·", label: "No trend" };
  const atMs = typeof row.date === "number" ? row.date : Number.NaN;
  if (!Number.isFinite(atMs)) return null;
  return {
    available: true,
    mgdl: Math.round(row.sgv),
    arrow: trend.arrow,
    label: trend.label,
    at: new Date(atMs).toISOString(),
    minutesAgo: Math.max(0, Math.round((now - atMs) / 60_000)),
  };
}

let cache: { at: number; value: GlucoseDTO } | null = null;
let lastLogged = "";

export function clearGlucoseCache(): void {
  cache = null;
  lastLogged = "";
}

function note(reason: string, detail?: string): void {
  const key = detail ? `${reason}:${detail}` : reason;
  if (key === lastLogged) return;
  lastLogged = key;
  console.warn(detail ? `Nightscout: ${reason} (${detail})` : `Nightscout: ${reason}`);
}

function errorCode(error: unknown): string | undefined {
  const candidates = [error, error instanceof Error ? error.cause : undefined];
  for (const item of candidates) {
    if (item && typeof item === "object" && "code" in item && typeof item.code === "string" && /^[A-Z0-9_]+$/.test(item.code)) {
      return item.code;
    }
  }
  return undefined;
}

function failureDetail(error: unknown, token: string): string | undefined {
  const code = errorCode(error);
  if (code) return code;
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const message = error instanceof Error ? error.message : "";
  const text = scrubSecret(cause || message, token).trim();
  return text || undefined;
}

function remember(value: GlucoseDTO, now: number): GlucoseDTO {
  cache = { at: now, value };
  if (value.available) note("ok");
  else note(value.reason ?? "unknown", value.detail);
  return value;
}

/**
 * Read the latest Nightscout SGV. This function only sends GET.
 * Steady never writes to Nightscout or Loop.
 */
export async function readGlucose(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<GlucoseDTO> {
  const base = process.env.NIGHTSCOUT_URL ?? "";
  const token = process.env.NIGHTSCOUT_TOKEN ?? "";
  const missing = [base.trim() ? "" : "NIGHTSCOUT_URL", normalizeNightscoutToken(token) ? "" : "NIGHTSCOUT_TOKEN"].filter(Boolean);
  if (missing.length > 0) {
    return remember({ available: false, reason: "not_configured", detail: missing.join(" and ") }, now);
  }
  if (cache && now - cache.at < CACHE_MS) return cache.value;

  const url = nightscoutEntriesUrl(base, token);
  try {
    const response = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      return remember({ available: false, reason: `http_${response.status}` }, now);
    }
    const parsed = parseNightscout(await response.json(), now);
    if (!parsed) return remember({ available: false, reason: "bad_payload" }, now);
    const age = now - Date.parse(parsed.at);
    if (age > STALE_MS) {
      return remember({ ...parsed, available: false, reason: "stale" }, now);
    }
    return remember(parsed, now);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return remember({ available: false, reason: "timeout" }, now);
    }
    return remember({ available: false, reason: "network", detail: failureDetail(error, token) }, now);
  }
}
