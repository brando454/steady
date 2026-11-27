import type { Express, Request, Response } from "express";
import { createSteadyMcpRouter } from "./mcp";
import { createSteadyOauthRouter, createSteadyTokenRouter, sendSteadyMetadata, type SteadyDeps } from "./oauth";

export function attachSteadyPublic(app: Express, deps: SteadyDeps): void {
  app.use("/api/steady/oauth", createSteadyOauthRouter(deps));
  app.use("/api/steady/mcp", createSteadyMcpRouter(deps));
  const resource = (req: Request, res: Response) => sendSteadyMetadata(req, res, "resource");
  app.get("/.well-known/oauth-protected-resource/api/steady/mcp", resource);
  app.get("/.well-known/oauth-authorization-server/api/steady", (req, res) => sendSteadyMetadata(req, res, "authorization"));
}

export function attachSteadyTokens(app: Express, deps: SteadyDeps): void {
  app.use("/api/steady", createSteadyTokenRouter(deps));
}
