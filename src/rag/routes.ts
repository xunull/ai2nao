import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { countChunks, searchHybrid } from "./retrieve.js";
import { readRagConfig, resolveRagConfigPath } from "./config.js";
import { defaultRagDbPath } from "../config.js";

export type RagRouteDeps = {
  db: Database.Database;
  dbPath: string;
};

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function registerRagRoutes(app: Hono, deps: RagRouteDeps | undefined): void {
  app.get("/api/rag/status", (c) => {
    if (!deps) {
      return jsonErr(503, "RAG is not enabled on this server (index not opened).");
    }
    const cfg = readRagConfig();
    const n = countChunks(deps.db);
    return c.json({
      ok: true as const,
      dbPath: deps.dbPath,
      configPath: resolveRagConfigPath(),
      defaultDbPath: defaultRagDbPath(),
      configPresent: Boolean(cfg),
      corpusRoots: cfg?.corpusRoots ?? [],
      embeddingEnabled: Boolean(cfg?.embedding?.enabled),
      chunkCount: n,
    });
  });

  app.post("/api/rag/search", async (c) => {
    if (!deps) {
      return jsonErr(503, "RAG is not enabled on this server (index not opened).");
    }
    const body = (await c.req.json().catch(() => null)) as {
      query?: unknown;
      topK?: unknown;
    } | null;
    const query = typeof body?.query === "string" ? body.query.trim() : "";
    if (!query) return jsonErr(400, "query is required");

    const rawTopK = parseInt(String(body?.topK ?? 6), 10);
    const topK = Math.min(12, Math.max(1, rawTopK || 6));
    const hits = await searchHybrid(deps.db, query, topK, readRagConfig());
    return c.json({
      ok: true as const,
      query,
      hits: hits.map((hit) => ({
        id: hit.id,
        sourceRoot: hit.sourceRoot,
        filePath: hit.filePath,
        content: hit.content.length > 1200 ? `${hit.content.slice(0, 1200)}...` : hit.content,
        ftsRank: hit.ftsRank,
        cosine: hit.cosine,
      })),
    });
  });
}
