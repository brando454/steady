import { createHash, timingSafeEqual } from "crypto";
import type { Request } from "express";

const BLOCKED_PROTOCOLS = new Set(["javascript:", "data:", "file:", "blob:", "vbscript:"]);

/** Public origin for OAuth discovery. The first set env var wins, then the request host. */
export function publicOrigin(req: Request, envNames: string[] = ["ABBL_PUBLIC_URL"]): string {
  for (const name of envNames) {
    const configured = process.env[name]?.trim().replace(/\/$/, "");
    if (configured) return configured;
  }
  const proto = (req.get("x-forwarded-proto") ?? req.protocol).split(",")[0].trim();
  const host = (req.get("x-forwarded-host") ?? req.get("host") ?? "localhost").split(",")[0].trim();
  return `${proto}://${host}`;
}

export function redirectAllowed(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return Boolean(url.protocol) && !BLOCKED_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function pkceEqual(leftText: string, rightText: string): boolean {
  const left = Buffer.from(leftText);
  const right = Buffer.from(rightText);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

export function protectedResourceMetadata(resource: string, authorizationServer: string, scope: string) {
  return {
    resource,
    authorization_servers: [authorizationServer],
    bearer_methods_supported: ["header"],
    scopes_supported: [scope],
  };
}

export function authorizationServerMetadata(issuer: string, endpoints: { authorize: string; token: string; register: string; scope: string }) {
  return {
    issuer,
    authorization_endpoint: endpoints.authorize,
    token_endpoint: endpoints.token,
    registration_endpoint: endpoints.register,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [endpoints.scope],
  };
}
