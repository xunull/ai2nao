import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { countChunks, searchHybridDetailed } from "./retrieve.js";
import { readRagConfig, resolveRagConfigPath } from "./config.js";
import { defaultRagDbPath, defaultRagVectorDbPath } from "../config.js";
import { readVectorSyncState } from "./meta.js";
import { createVectorStore } from "./vectorStore/factory.js";
import { ragManifestCounts } from "./manifest.js";

export type RagRouteDeps = {
  db: Database.Database;
  dbPath: string;
};

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function registerRagRoutes(app: Hono, deps: RagRouteDeps | undefined): void {
  app.get("/api/rag/status", async (c) => {
    if (!deps) {
      return jsonErr(503, "RAG is not enabled on this server (index not opened).");
    }
    const cfg = readRagConfig();
    const n = countChunks(deps.db);
    const vectorStore = createVectorStore(cfg);
    const vectorStatus = await vectorStore.status();
    const vectorSync = readVectorSyncState(deps.db);
    const manifest = ragManifestCounts(deps.db);
    return c.json({
      ok: true as const,
      dbPath: deps.dbPath,
      configPath: resolveRagConfigPath(),
      defaultDbPath: defaultRagDbPath(),
      configPresent: Boolean(cfg),
      corpusRoots: cfg?.corpusRoots ?? [],
      embeddingEnabled: Boolean(cfg?.embedding?.enabled),
      chunkCount: n,
      manifest,
      vectorStore: {
        provider: vectorStore.provider,
        path:
          cfg?.vectorStore?.provider === "lancedb"
            ? cfg.vectorStore.path ?? defaultRagVectorDbPath()
            : null,
        ok: vectorStatus.ok,
        indexedCount: vectorStatus.indexedCount ?? 0,
        syncStatus: vectorSync.status ?? "none",
        embeddingModel: vectorSync.embeddingModel ?? null,
        embeddingDim: vectorSync.embeddingDim ?? null,
        error: vectorStatus.error ?? vectorSync.error ?? null,
      },
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
    const result = await searchHybridDetailed(deps.db, query, topK, readRagConfig());
    return c.json({
      ok: true as const,
      query,
      hits: result.hits.map((hit) => ({
        id: hit.chunkId,
        chunkId: hit.chunkId,
        sourceRoot: hit.sourceRoot,
        filePath: hit.filePath,
        content: hit.contentPreview,
        contentPreview: hit.contentPreview,
        truncated: hit.truncated,
        scores: hit.scores,
        ranks: hit.ranks,
        matchedBy: hit.matchedBy,
      })),
      meta: result.meta,
    });
  });

  app.post("/api/rag/debug-search", async (c) => {
    if (!deps) {
      return jsonErr(503, "RAG is not enabled on this server (index not opened).");
    }
    const body = (await c.req.json().catch(() => null)) as {
      query?: unknown;
      topK?: unknown;
    } | null;
    const query = typeof body?.query === "string" ? body.query.trim() : "";
    if (!query) return jsonErr(400, "query is required");

    const rawTopK = parseInt(String(body?.topK ?? 8), 10);
    const topK = Math.min(20, Math.max(1, rawTopK || 8));
    const result = await searchHybridDetailed(deps.db, query, topK, readRagConfig());
    return c.json({
      ok: true as const,
      query,
      fts: result.fts,
      vector: result.vector,
      hybrid: result.hits,
      meta: result.meta,
    });
  });
}
