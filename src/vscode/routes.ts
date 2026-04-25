import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { cleanOptionalString, parseListQuery } from "../serve/listQuery.js";
import { getVscodeMirrorStatus, listVscodeRecentEntries, listVscodeRecentProjects } from "./queries.js";
import { parseVscodeAppId } from "./paths.js";
import { syncVscodeRecent } from "./sync.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function registerVscodeRoutes(app: Hono, db: Database.Database): void {
  app.get("/api/vscode/status", (c) => {
    try {
      const appId = cleanOptionalString(c.req.query("app")) ?? "code";
      if (!parseVscodeAppId(appId)) return jsonErr(400, "invalid app");
      return c.json(getVscodeMirrorStatus(db, { app: appId }));
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/api/vscode/recent", (c) => {
    try {
      const parsed = parseListQuery((key) => c.req.query(key));
      if ("error" in parsed) return jsonErr(400, parsed.error);
      const appId = cleanOptionalString(c.req.query("app")) ?? "code";
      if (!parseVscodeAppId(appId)) return jsonErr(400, "invalid app");
      const kind = cleanOptionalString(c.req.query("kind"));
      const scope = cleanOptionalString(c.req.query("scope"));
      if (scope && !["all", "local", "remote"].includes(scope)) return jsonErr(400, "invalid scope");
      return c.json(
        listVscodeRecentEntries(db, {
          ...parsed,
          app: appId,
          kind,
          scope: (scope as "all" | "local" | "remote" | undefined) ?? "all",
        })
      );
    } catch (e) {
      return jsonErr(400, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/api/vscode/recent-projects", (c) => {
    try {
      const parsed = parseListQuery((key) => c.req.query(key));
      if ("error" in parsed) return jsonErr(400, parsed.error);
      const appId = cleanOptionalString(c.req.query("app")) ?? "code";
      if (!parseVscodeAppId(appId)) return jsonErr(400, "invalid app");
      const scope = cleanOptionalString(c.req.query("scope"));
      if (scope && !["all", "local", "remote"].includes(scope)) return jsonErr(400, "invalid scope");
      return c.json(
        listVscodeRecentProjects(db, {
          ...parsed,
          app: appId,
          scope: (scope as "all" | "local" | "remote" | undefined) ?? "all",
        })
      );
    } catch (e) {
      return jsonErr(400, e instanceof Error ? e.message : String(e));
    }
  });

  app.post("/api/vscode/sync", async (c) => {
    try {
      const body = await safeJson(c.req.raw);
      const appId = typeof body.app === "string" ? body.app : "code";
      if (!parseVscodeAppId(appId)) return jsonErr(400, "invalid app");
      const result = syncVscodeRecent(db, { app: appId });
      if (!result.ok) return jsonErr(500, result.warnings[0]?.message ?? "VS Code sync failed");
      return c.json(result);
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });
}

async function safeJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
