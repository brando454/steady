import { normalizeNightscoutBase, normalizeNightscoutToken, scrubSecret } from "./nightscout";
import { assertNightscoutNoteSafe, nightscoutNotePayload, type MealNoteInput } from "../shared/nightscoutNote";

export type NoteDelivery =
  | { ok: true; id: string }
  | { ok: false; reason: string };

function treatmentsUrl(base: string, token: string, id?: string): URL {
  const root = normalizeNightscoutBase(base);
  const path = id ? `/api/v1/treatments/${encodeURIComponent(id)}` : "/api/v1/treatments";
  const url = new URL(`${root}${path}`);
  url.searchParams.set("token", normalizeNightscoutToken(token));
  return url;
}

function readId(data: unknown): string | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") return null;
  const id = (row as Record<string, unknown>)._id;
  if (typeof id === "string" && id.length > 0 && id.length < 80) return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
}

function notesMatch(data: unknown, notes: string, createdAt: string): string | null {
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.eventType !== "Note" || row.enteredBy !== "Steady") continue;
    if (row.notes !== notes) continue;
    if (row.created_at !== createdAt) continue;
    const id = readId(row);
    if (id) return id;
  }
  return null;
}

async function send(
  url: URL,
  method: "POST" | "PUT" | "DELETE" | "GET",
  token: string,
  body: Record<string, unknown> | null,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; data: unknown } | { ok: false; reason: string }> {
  if (body) assertNightscoutNoteSafe(body);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (method === "DELETE" && response.status === 404) return { ok: true, data: null };
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    if (method === "DELETE") return { ok: true, data: null };
    try {
      return { ok: true, data: await response.json() };
    } catch {
      return { ok: false, reason: "bad_payload" };
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") return { ok: false, reason: "timeout" };
    const message = error instanceof Error ? error.message : "";
    return { ok: false, reason: scrubSecret(message, token).trim() || "network" };
  }
}

/**
 * Create or update one Note treatment.
 * The body is built by `nightscoutNotePayload` and checked again before it is sent.
 * This uses `NIGHTSCOUT_WRITE_TOKEN` only. The read token is never sent here.
 */
export async function deliverNightscoutNote(input: {
  meal: MealNoteInput & { createdAt: string };
  existingId?: string | null;
  fetchImpl?: typeof fetch;
  base?: string;
  token?: string;
}): Promise<NoteDelivery> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.base ?? process.env.NIGHTSCOUT_URL ?? "";
  const token = input.token ?? process.env.NIGHTSCOUT_WRITE_TOKEN ?? "";
  if (!base.trim() || !normalizeNightscoutToken(token)) return { ok: false, reason: "not_configured" };
  const payload = nightscoutNotePayload({ ...input.meal, id: input.existingId || undefined });
  const existingId = input.existingId || null;
  if (!existingId) {
    const foundUrl = treatmentsUrl(base, token);
    foundUrl.pathname = "/api/v1/treatments.json";
    foundUrl.searchParams.set("find[enteredBy]", "Steady");
    foundUrl.searchParams.set("find[created_at]", input.meal.createdAt);
    foundUrl.searchParams.set("count", "10");
    const found = await send(foundUrl, "GET", token, null, fetchImpl);
    if (found.ok) {
      const match = notesMatch(found.data, payload.notes, input.meal.createdAt);
      if (match) return { ok: true, id: match };
    }
  }
  const url = treatmentsUrl(base, token, existingId ?? undefined);
  const sent = await send(url, existingId ? "PUT" : "POST", token, payload, fetchImpl);
  if (!sent.ok) return sent;
  const id = readId(sent.data) ?? existingId;
  if (!id) return { ok: false, reason: "missing_id" };
  return { ok: true, id };
}

/** Delete a Note. A missing treatment counts as already gone. No request body is sent. */
export async function deleteNightscoutNote(input: {
  id: string;
  fetchImpl?: typeof fetch;
  base?: string;
  token?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.base ?? process.env.NIGHTSCOUT_URL ?? "";
  const token = input.token ?? process.env.NIGHTSCOUT_WRITE_TOKEN ?? "";
  if (!input.id || !base.trim() || !normalizeNightscoutToken(token)) return { ok: false, reason: "not_configured" };
  const result = await send(treatmentsUrl(base, token, input.id), "DELETE", token, null, fetchImpl);
  if (!result.ok) return result;
  return { ok: true };
}
