import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { getCodexTokenUsageStatus } from "./queries.js";
import { refreshCodexTokenUsage } from "./refresh.js";

function boolQuery(raw: string | undefined): boolean {
  if (raw == null) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function registerCodexTokenUsageRoutes(app: Hono, db: Database.Database) {
  app.get("/api/codex-token-usage/status", (c) => {
    try {
      return c.json(getCodexTokenUsageStatus(db));
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.post("/api/codex-token-usage/refresh", async (c) => {
    try {
      const result = await refreshCodexTokenUsage(db, {
        full: boolQuery(c.req.query("full")),
      });
      return c.json(result);
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });
}
