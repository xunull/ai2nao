import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { countChunks } from "./retrieve.js";
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
}
