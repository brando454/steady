import { randomUUID } from "crypto";
import express, { Router, type Request, type Response } from "express";
import { rateLimit } from "../auth";
import { authorizationServerMetadata, escapeHtml, pkceEqual, pkceS256, protectedResourceMetadata, publicOrigin, redirectAllowed } from "../oauth-http";
import { HttpError } from "../util";
import type { AbblStore, OauthClient } from "./records";
import { newPrefixedToken, readPersonName, tokenHash, userFromCode } from "./service";

const ACCESS_SECONDS = 60 * 60;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_MS = 5 * 60 * 1000;

export type OauthDeps = {
  store: AbblStore;
  now?: () => Date;
};

export { publicOrigin, redirectAllowed };

export function mcpResource(origin: string): string {
  return `${origin}/api/abbl/mcp`;
}

export function oauthMetadata(req: Request): { resource: Record<string, unknown>; authorization: Record<string, unknown> } {
  const origin = publicOrigin(req);
  const resource = mcpResource(origin);
  return {
    resource: protectedResourceMetadata(resource, origin, "meals"),
    authorization: authorizationServerMetadata(origin, {
      authorize: `${origin}/api/abbl/oauth/authorize`,
      token: `${origin}/api/abbl/oauth/token`,
      register: `${origin}/api/abbl/oauth/register`,
      scope: "meals",
    }),
  };
}

function field(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function authorizePage(fields: Record<string, string>, message: string): string {
  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "resource", "scope"]
    .map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(fields[name] ?? "")}">`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in to abbl</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f4ef;color:#1c1915;margin:0}main{max-width:24rem;margin:4rem auto;padding:1.5rem}label,button,input{display:block;width:100%}input,button{font:inherit;padding:.7rem;margin:.4rem 0 1rem}button{background:#1c1915;color:#fff;border:0}p{color:#6b6258}</style>
</head><body><main><h1>Sign in to abbl</h1><p>${escapeHtml(message)}</p>
<form method="post"><label for="code">Invite code</label><input id="code" name="code" autocomplete="one-time-code" required>${hidden}
<button type="submit">Continue</button></form></main></body></html>`;
}

async function issueTokens(store: AbblStore, userId: string, client: OauthClient, connectionId: string, now: Date) {
  const access = newPrefixedToken("abbl_at");
  const refresh = newPrefixedToken("abbl_rt");
  const createdAt = now.toISOString();
  await store.saveApiToken({
    id: randomUUID(),
    userId,
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
    userId,
    clientId: client.id,
    connectionId,
    expiresAt: new Date(now.getTime() + REFRESH_MS).toISOString(),
  });
  return { access_token: access, token_type: "Bearer" as const, expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: "meals" };
}

export function createOauthRouter(deps: OauthDeps): Router {
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
      const authMethod = req.body?.token_endpoint_auth_method;
      if (authMethod != null && authMethod !== "none") throw new HttpError(400, "Public clients only");
      const client: OauthClient = {
        id: `abbl_client_${randomUUID()}`,
        name,
        redirectUris: redirects.map((uri: string) => uri),
        createdAt: now().toISOString(),
      };
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
    const fields = {
      client_id: field(req.query.client_id),
      redirect_uri: field(req.query.redirect_uri),
      state: field(req.query.state),
      code_challenge: field(req.query.code_challenge),
      code_challenge_method: field(req.query.code_challenge_method),
      resource: field(req.query.resource),
      scope: field(req.query.scope),
    };
    res.type("html").send(authorizePage(fields, "Enter the invite code for your abbl account."));
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
      const fail = (message: string) => {
        res.status(400).type("html").send(authorizePage(fields, message));
      };
      const client = await store.oauthClient(fields.client_id);
      if (!client || !client.redirectUris.includes(fields.redirect_uri)) return fail("This app is not registered.");
      if (!fields.state || fields.state.length > 200) return fail("The sign-in request is missing state.");
      if (fields.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(fields.code_challenge)) {
        return fail("This app must use PKCE S256.");
      }
      const resource = mcpResource(publicOrigin(req));
      if (fields.resource && fields.resource !== resource) return fail("This app asked for the wrong resource.");
      if (fields.scope && fields.scope !== "meals") return fail("The only scope is meals.");
      const ip = req.ip || "unknown";
      if (!rateLimit(`abbl-oauth:${ip}`, 8, 15 * 60 * 1000, now().getTime())) return fail("Too many tries. Wait a few minutes.");
      let user;
      try {
        user = await userFromCode(store, field(req.body?.code), readPersonName(req.body?.name, false), now());
      } catch (error) {
        if (error instanceof HttpError) return fail("That code is not valid.");
        throw error;
      }
      const plain = newPrefixedToken("abbl_ac");
      await store.saveAuthCode({
        codeHash: tokenHash(plain),
        clientId: client.id,
        userId: user.id,
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
      if (grant === "authorization_code") {
        const clock = now();
        const code = await store.peekAuthCode(tokenHash(field(req.body?.code)), clock);
        const verifier = field(req.body?.code_verifier);
        const redirect = field(req.body?.redirect_uri);
        const matches = code && code.clientId === client.id && code.redirectUri === redirect && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && pkceEqual(pkceS256(verifier), code.codeChallenge);
        if (!code || !matches || !(await store.takeAuthCode(tokenHash(field(req.body?.code)), clock))) {
          res.status(400).json({ error: "invalid_grant" });
          return;
        }
        const connectionId = randomUUID();
        await store.saveConnection({ id: connectionId, userId: code.userId, clientId: client.id, name: client.name, createdAt: now().toISOString(), revokedAt: null });
        res.json(await issueTokens(store, code.userId, client, connectionId, now()));
        return;
      }
      if (grant === "refresh_token") {
        const current = await store.takeRefreshToken(tokenHash(field(req.body?.refresh_token)), now());
        if (!current || current.clientId !== client.id) {
          res.status(400).json({ error: "invalid_grant" });
          return;
        }
        const user = await store.userById(current.userId);
        if (!user || user.disabled) {
          res.status(400).json({ error: "invalid_grant" });
          return;
        }
        await store.revokeAccessForConnection(user.id, current.connectionId);
        res.json(await issueTokens(store, user.id, client, current.connectionId, now()));
        return;
      }
      res.status(400).json({ error: "unsupported_grant_type" });
    })().catch(next);
  });

  return router;
}

export function sendOauthMetadata(req: Request, res: Response, kind: "resource" | "authorization"): void {
  const metadata = oauthMetadata(req);
  res.json(kind === "resource" ? metadata.resource : metadata.authorization);
}
