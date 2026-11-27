import type { Express, Request, Response } from "express";
import { createMcpRouter } from "./mcp";
import { createOauthRouter, sendOauthMetadata } from "./oauth";
import { createAbblRouter, type AbblDeps } from "./router";

export function attachAbbl(app: Express, deps: AbblDeps): void {
  app.use("/api/abbl/v1", createAbblRouter(deps));
  app.use("/api/abbl/oauth", createOauthRouter(deps));
  app.use("/api/abbl/mcp", createMcpRouter(deps));
  const resource = (req: Request, res: Response) => sendOauthMetadata(req, res, "resource");
  app.get("/.well-known/oauth-protected-resource", resource);
  app.get("/.well-known/oauth-protected-resource/api/abbl/mcp", resource);
  app.get("/.well-known/oauth-authorization-server", (req, res) => sendOauthMetadata(req, res, "authorization"));
}
