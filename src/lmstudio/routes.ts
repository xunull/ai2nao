import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { cleanOptionalString, parseListQuery } from "../serve/listQuery.js";
import { getLmStudioStatus, listLmStudioModels, parseLmStudioFormat } from "./queries.js";
import { resolveLmStudioModelsRoot } from "./roots.js";
import { syncLmStudioModels } from "./sync.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function registerLmStudioRoutes(app: Hono, db: Database.Database): void {
  app.get("/api/lmstudio/status", (c) => {
    const root = cleanOptionalString(c.req.query("root"));
    return c.json(getLmStudioStatus(db, root));
  });

  app.get("/api/lmstudio/models", (c) => {
    const parsed = parseListQuery((key) => c.req.query(key));
    if ("error" in parsed) return jsonErr(400, parsed.error);
    const root = cleanOptionalString(c.req.query("root"));
    const formatRaw = cleanOptionalString(c.req.query("format"));
    const format = parseLmStudioFormat(formatRaw);
    if (formatRaw && !format) return jsonErr(400, "invalid format");
    const resolved = resolveLmStudioModelsRoot(root);
    return c.json(listLmStudioModels(db, { ...parsed, format, modelsRoot: resolved.modelsRoot }));
  });

  app.post("/api/lmstudio/sync", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { root?: unknown };
      const root = typeof body.root === "string" ? body.root : undefined;
      if (body.root != null && typeof body.root !== "string") return jsonErr(400, "invalid root");
      const result = syncLmStudioModels(db, { root });
      if (!result.ok) return jsonErr(500, result.errorSummary ?? "lmstudio sync failed");
      return c.json(result);
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });
}
