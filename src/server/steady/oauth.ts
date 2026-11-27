import { randomBytes, randomUUID } from "crypto";
import express, { Router, type Request, type Response } from "express";
import { COOKIE, bearerToken, rateLimit, secretsMatch, verifySession } from "../auth";
import { authorizationServerMetadata, escapeHtml, pkceEqual, pkceS256, protectedResourceMetadata, publicOrigin, redirectAllowed } from "../oauth-http";
import { HttpError, cleanText, cookieValue } from "../util";
import { tokenHash, type OauthClient, type SteadyStore } from "./store";

const ACCESS_SECONDS = 60 * 60;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_MS = 5 * 60 * 1000;
const ORIGIN_ENV = ["STEADY_PUBLIC_URL", "ABBL_PUBLIC_URL"];

export type SteadyDeps = {
  store: SteadyStore;
  passcode: string;
  now?: () => Date;
};

export function steadyOrigin(req: Request): string {
  return publicOrigin(req, ORIGIN_ENV);
}

export function steadyResource(origin: string): string {
  return `${origin}/api/steady/mcp`;
}

export function steadyMetadata(req: Request) {
  const origin = steadyOrigin(req);
  const issuer = `${origin}/api/steady`;
  const resource = steadyResource(origin);
  return {
    resource: protectedResourceMetadata(resource, issuer, "workouts"),
    authorization: authorizationServerMetadata(issuer, {
      authorize: `${origin}/api/steady/oauth/authorize`,
      token: `${origin}/api/steady/oauth/token`,
      register: `${origin}/api/steady/oauth/register`,
      scope: "workouts",
    }),
  };
}

function prefixed(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function field(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function authorizePage(fields: Record<string, string>, message: string): string {
  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "resource", "scope"]
    .map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(fields[name] ?? "")}">`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in to Steady</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f7f5;color:#14211b;margin:0}main{max-width:24rem;margin:4rem auto;padding:1.5rem}label,button,input{display:block;width:100%}input,button{font:inherit;padding:.7rem;margin:.4rem 0 1rem}button{background:#14211b;color:#fff;border:0}p{color:#5d6b63}</style>
</head><body><main><h1>Sign in to Steady</h1><p>${escapeHtml(message)}</p>
<form method="post"><label for="passcode">Passcode</label><input id="passcode" name="passcode" type="password" autocomplete="current-password" required>${hidden}
<button type="submit">Continue</button></form></main></body></html>`;
}

async function issueTokens(store: SteadyStore, client: OauthClient, connectionId: string, now: Date) {
  const access = prefixed("steady_at");
  const refresh = prefixed("steady_rt");
  const createdAt = now.toISOString();
  await store.saveApiToken({
    id: randomUUID(),
    tokenHash: tokenHash(access),
    kind: "oauth",
    name: client.name,
    clientId: client.id,
    connectionId,
    expiresAt: new Date(now.getTime() + ACCESS_SECONDS * 1000).toISOString(),
    lastUsedAt: null,
    createdAt,
    revokedAt: null,
  });
  await store.saveRefreshToken({
    tokenHash: tokenHash(refresh),
    clientId: client.id,
    connectionId,
    expiresAt: new Date(now.getTime() + REFRESH_MS).toISOString(),
  });
  return { access_token: access, token_type: "Bearer" as const, expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: "workouts" };
}

export function createSteadyOauthRouter(deps: SteadyDeps): Router {
  const store = deps.store;
  const now = deps.now ?? (() => new Date());
  const router = Router();
  router.use(express.urlencoded({ extended: false }));

  router.post("/register", (req, res, next) => {
    void (async () => {
      const name = typeof req.body?.client_name === "string" ? req.body.client_name.trim() : "";
      const redirects = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
      if (!name || name.length > 80) throw new HttpError(400, "client_name looks off");
      if (redirects.length < 1 || redirects.length > 8 || redirects.some((uri: unknown) => typeof uri !== "string" || !redirectAllowed(uri))) {
        throw new HttpError(400, "redirect_uris looks off");
      }
      if (req.body?.token_endpoint_auth_method != null && req.body.token_endpoint_auth_method !== "none") throw new HttpError(400, "Public clients only");
      const client: OauthClient = { id: `steady_client_${randomUUID()}`, name, redirectUris: redirects, createdAt: now().toISOString() };
      await store.saveOauthClient(client);
      res.status(201).json({
        client_id: client.id,
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      });
    })().catch(next);
  });

  router.get("/authorize", (req, res) => {
    res.type("html").send(
      authorizePage(
        {
          client_id: field(req.query.client_id),
          redirect_uri: field(req.query.redirect_uri),
          state: field(req.query.state),
          code_challenge: field(req.query.code_challenge),
          code_challenge_method: field(req.query.code_challenge_method),
          resource: field(req.query.resource),
          scope: field(req.query.scope),
        },
        "Enter the Steady passcode.",
      ),
    );
  });

  router.post("/authorize", (req, res, next) => {
    void (async () => {
      const fields = {
        client_id: field(req.body?.client_id),
        redirect_uri: field(req.body?.redirect_uri),
        state: field(req.body?.state),
        code_challenge: field(req.body?.code_challenge),
        code_challenge_method: field(req.body?.code_challenge_method),
        resource: field(req.body?.resource),
        scope: field(req.body?.scope),
      };
      const fail = (message: string) => res.status(400).type("html").send(authorizePage(fields, message));
      const client = await store.oauthClient(fields.client_id);
      if (!client || !client.redirectUris.includes(fields.redirect_uri)) return fail("This app is not registered.");
      if (!fields.state || fields.state.length > 200) return fail("The sign-in request is missing state.");
      if (fields.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(fields.code_challenge)) return fail("This app must use PKCE S256.");
      if (fields.resource && fields.resource !== steadyResource(steadyOrigin(req))) return fail("This app asked for the wrong resource.");
      if (fields.scope && fields.scope !== "workouts") return fail("The only scope is workouts.");
      if (!rateLimit(`steady-oauth:${req.ip || "unknown"}`, 8, 15 * 60 * 1000, now().getTime())) return fail("Too many tries. Wait a few minutes.");
      const passcode = field(req.body?.passcode);
      if (!passcode || !secretsMatch(passcode, deps.passcode)) return fail("Wrong passcode.");
      const plain = prefixed("steady_ac");
      await store.saveAuthCode({
        codeHash: tokenHash(plain),
        clientId: client.id,
        redirectUri: fields.redirect_uri,
        codeChallenge: fields.code_challenge,
        expiresAt: new Date(now().getTime() + CODE_MS).toISOString(),
      });
      const target = new URL(fields.redirect_uri);
      target.searchParams.set("code", plain);
      target.searchParams.set("state", fields.state);
      res.redirect(302, target.toString());
    })().catch(next);
  });

  router.post("/token", (req, res, next) => {
    void (async () => {
      res.set("Cache-Control", "no-store");
      const client = await store.oauthClient(field(req.body?.client_id));
      if (!client) {
        res.status(400).json({ error: "invalid_client" });
        return;
      }
      const grant = field(req.body?.grant_type);
      const clock = now();
      if (grant === "authorization_code") {
        const code = await store.peekAuthCode(tokenHash(field(req.body?.code)), clock);
        const verifier = field(req.body?.code_verifier);
        const redirect = field(req.body?.redirect_uri);
        const matches = code && code.clientId === client.id && code.redirectUri === redirect && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && pkceEqual(pkceS256(verifier), code.codeChallenge);
        if (!code || !matches || !(await store.takeAuthCode(tokenHash(field(req.body?.code)), clock))) {
          res.status(400).json({ error: "invalid_grant" });
          return;
        }
        const connectionId = randomUUID();
        await store.saveConnection({ id: connectionId, clientId: client.id, name: client.name, createdAt: clock.toISOString(), revokedAt: null });
        res.json(await issueTokens(store, client, connectionId, clock));
        return;
      }
      if (grant === "refresh_token") {
        const current = await store.takeRefreshToken(tokenHash(field(req.body?.refresh_token)), clock);
        if (!current || current.clientId !== client.id) {
          res.status(400).json({ error: "invalid_grant" });
          return;
        }
        await store.revokeAccessForConnection(current.connectionId);
        res.json(await issueTokens(store, client, current.connectionId, clock));
        return;
      }
      res.status(400).json({ error: "unsupported_grant_type" });
    })().catch(next);
  });

  return router;
}

export function createSteadyTokenRouter(deps: SteadyDeps): Router {
  const store = deps.store;
  const now = deps.now ?? (() => new Date());
  const router = Router();
  router.use((req, res, next) => {
    const token = bearerToken(req.get("authorization")) || cookieValue(req.headers.cookie, COOKIE) || "";
    if (!token || !verifySession(token, deps.passcode)) {
      res.status(401).json({ error: "Locked" });
      return;
    }
    next();
  });
  router.post("/tokens", (req, res, next) => {
    void (async () => {
      const name = cleanText(req.body?.name, "Name", 80);
      const secret = prefixed("steady_pat");
      const createdAt = now().toISOString();
      const id = randomUUID();
      await store.saveApiToken({
        id,
        tokenHash: tokenHash(secret),
        kind: "pat",
        name,
        clientId: null,
        connectionId: null,
        expiresAt: null,
        lastUsedAt: null,
        createdAt,
        revokedAt: null,
      });
      res.status(201).json({ token: { id, name, token: secret, createdAt } });
    })().catch(next);
  });
  router.get("/connections", (_req, res, next) => {
    void store.listCredentials().then((body) => res.json(body)).catch(next);
  });
  router.delete("/tokens/:id", (req, res, next) => {
    void (async () => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) throw new HttpError(404, "Connection not found");
      if (!(await store.revokeCredential(req.params.id))) throw new HttpError(404, "Connection not found");
      res.json({ ok: true });
    })().catch(next);
  });
  return router;
}

export function sendSteadyMetadata(req: Request, res: Response, kind: "resource" | "authorization"): void {
  const metadata = steadyMetadata(req);
  res.json(kind === "resource" ? metadata.resource : metadata.authorization);
}
