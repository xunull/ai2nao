import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { cleanOptionalString, parseListQuery } from "../serve/listQuery.js";
import { getHuggingfaceStatus, listHuggingfaceModels } from "./queries.js";
import { resolveHuggingfaceHubCacheRoot } from "./roots.js";
import { syncHuggingfaceModels } from "./sync.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function registerHuggingfaceRoutes(app: Hono, db: Database.Database): void {
  app.get("/api/huggingface/status", (c) => {
    const root = cleanOptionalString(c.req.query("root"));
    return c.json(getHuggingfaceStatus(db, root));
  });

  app.get("/api/huggingface/models", (c) => {
    const parsed = parseListQuery((key) => c.req.query(key));
    if ("error" in parsed) return jsonErr(400, parsed.error);
    const root = cleanOptionalString(c.req.query("root"));
    const resolved = resolveHuggingfaceHubCacheRoot(root);
    return c.json(
      listHuggingfaceModels(db, {
        ...parsed,
        cacheRoot: resolved.cacheRoot,
      })
    );
  });

  app.post("/api/huggingface/sync", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { root?: unknown };
      const root = typeof body.root === "string" ? body.root : undefined;
      if (body.root != null && typeof body.root !== "string") {
        return jsonErr(400, "invalid root");
      }
      const result = syncHuggingfaceModels(db, { root });
      if (!result.ok) return jsonErr(500, result.errorSummary ?? "huggingface sync failed");
      return c.json(result);
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });
}
