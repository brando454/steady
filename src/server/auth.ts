import { createHash, createHmac, timingSafeEqual } from "crypto";

export const COOKIE = "steady_session";
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const YEAR_SEC = 365 * 24 * 60 * 60;

export function signSession(passcode: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ exp: now + YEAR_MS, v: 1 })).toString("base64url");
  const sig = createHmac("sha256", passcode).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(token: string, passcode: string, now = Date.now()): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [body, sig] = parts;
  const expected = createHmac("sha256", passcode).update(body).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { exp?: number; v?: number };
    return payload.v === 1 && typeof payload.exp === "number" && payload.exp > now;
  } catch {
    return false;
  }
}

/** Session token from `Authorization: Bearer`, used by the native app. Empty when the header is not a bearer token. */
export function bearerToken(authorization: string | undefined): string {
  const match = /^Bearer\s+(\S+)$/i.exec((authorization ?? "").trim());
  return match?.[1]?.trim() ?? "";
}

export function presentedWidgetToken(authorization: string | undefined, queryToken: unknown): string {
  const header = authorization ?? "";
  const match = /^Bearer\s+(\S.*)$/i.exec(header);
  if (match) {
    const token = match[1].trim();
    if (token) return token;
  }
  if (typeof queryToken === "string") return queryToken.trim();
  if (Array.isArray(queryToken) && typeof queryToken[0] === "string") return queryToken[0].trim();
  return "";
}

export function widgetTokenOk(presented: string, configured: string | undefined): boolean {
  const expected = configured?.trim() ?? "";
  if (!expected || !presented) return false;
  return secretsMatch(presented, expected);
}

export function secretsMatch(input: string, expected: string): boolean {
  const left = createHash("sha256").update(input).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export function sessionCookie(token: string, secure: boolean): string {
  const parts = [`${COOKIE}=${token}`, "HttpOnly", "Path=/", `Max-Age=${YEAR_SEC}`, "SameSite=Lax"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(secure: boolean): string {
  const parts = [`${COOKIE}=`, "HttpOnly", "Path=/", "Max-Age=0", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

const attempts = new Map<string, { count: number; reset: number }>();

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const current = attempts.get(key);
  if (!current || current.reset < now) {
    attempts.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

export function resetRateLimit(): void {
  attempts.clear();
}
