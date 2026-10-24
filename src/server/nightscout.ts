import type { GlucoseDTO } from "../shared/types";

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

export function nightscoutEntriesUrl(base: string, token: string): URL {
  const root = base.trim().replace(/\/+$/, "");
  const url = new URL(`${root}/api/v1/entries.json`);
  url.searchParams.set("token", token);
  url.searchParams.set("count", "1");
  return url;
}

export function parseNightscout(data: unknown, now = Date.now()): Exclude<GlucoseDTO, { available: false }> | null {
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

export function clearGlucoseCache(): void {
  cache = null;
}

/**
 * Read the latest Nightscout SGV. This function only sends GET.
 * Steady never writes to Nightscout or Loop.
 */
export async function readGlucose(fetchImpl: typeof fetch = fetch): Promise<GlucoseDTO> {
  const base = process.env.NIGHTSCOUT_URL?.trim();
  const token = process.env.NIGHTSCOUT_TOKEN?.trim();
  if (!base || !token) return { available: false };
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  try {
    const url = nightscoutEntriesUrl(base, token);
    const response = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      const hidden = { available: false } as const;
      cache = { at: Date.now(), value: hidden };
      return hidden;
    }
    const parsed = parseNightscout(await response.json());
    const value: GlucoseDTO = parsed ?? { available: false };
    cache = { at: Date.now(), value };
    return value;
  } catch {
    return { available: false };
  }
}
