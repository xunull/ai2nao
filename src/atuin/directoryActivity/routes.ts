import type { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  getDirectoryActivityStatus,
  listDirectoryActivityCommands,
  listTopDirectoryActivityDirs,
  searchDirectoryActivityDirs,
} from "./queries.js";
import { rebuildDirectoryActivity } from "./rebuild.js";
import type { DirectoryActivityErrorCode, DirectoryActivityMode } from "./types.js";

type AtuinSource = { db: Database.Database; path: string };

function jsonErr(
  status: number,
  message: string,
  code?: DirectoryActivityErrorCode | "invalid_request"
) {
  return Response.json({ error: { message, code } }, { status });
}

function parseMode(raw: string | undefined): DirectoryActivityMode | null {
  const value = (raw ?? "filtered").trim();
  if (value === "raw" || value === "filtered") return value;
  return null;
}

function parseLimit(raw: string | undefined, fallback: number): number | null {
  if (raw == null || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 200) return null;
  return n;
}

function boundedQuery(raw: string | undefined, max: number): string | null {
  const q = (raw ?? "").trim();
  if (q.length > max) return null;
  return q;
}

export function registerAtuinDirectoryActivityRoutes(
  app: Hono,
  indexDb: Database.Database,
  atuin?: AtuinSource
): void {
  app.get("/api/atuin/directories/status", (c) => {
    try {
      return c.json({
        enabled: !!atuin,
        atuinPath: atuin?.path ?? null,
        directoryActivity: getDirectoryActivityStatus(indexDb),
      });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.post("/api/atuin/directories/rebuild", (c) => {
    try {
      if (!atuin) return jsonErr(503, "Atuin history not configured", "not_configured");
      const result = rebuildDirectoryActivity({
        indexDb,
        atuinDb: atuin.db,
      });
      if (!result.ok) {
        const status =
          result.errorCode === "rebuild_in_progress"
            ? 409
            : result.errorCode === "config_error"
              ? 400
              : 500;
        return jsonErr(status, result.error ?? "rebuild failed", result.errorCode ?? undefined);
      }
      return c.json({
        ok: true,
        result,
        directoryActivity: getDirectoryActivityStatus(indexDb),
      });
    } catch (e) {
      return jsonErr(500, String(e), "rebuild_failed");
    }
  });

  app.get("/api/atuin/directories/top", (c) => {
    try {
      const mode = parseMode(c.req.query("mode"));
      if (!mode) return jsonErr(400, "invalid mode", "invalid_request");
      const limit = parseLimit(c.req.query("limit"), 50);
      if (limit == null) return jsonErr(400, "invalid limit", "invalid_request");
      return c.json({ mode, directories: listTopDirectoryActivityDirs(indexDb, { mode, limit }) });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/atuin/directories/search", (c) => {
    try {
      const q = boundedQuery(c.req.query("q"), 200);
      if (q == null) return jsonErr(400, "query too long", "invalid_request");
      const mode = parseMode(c.req.query("mode"));
      if (!mode) return jsonErr(400, "invalid mode", "invalid_request");
      const limit = parseLimit(c.req.query("limit"), 50);
      if (limit == null) return jsonErr(400, "invalid limit", "invalid_request");
      return c.json({
        mode,
        q,
        directories: q
          ? searchDirectoryActivityDirs(indexDb, { q, mode, limit })
          : [],
      });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/atuin/directories/commands", (c) => {
    try {
      const cwd = boundedQuery(c.req.query("cwd"), 4096);
      if (cwd == null) return jsonErr(400, "cwd too long", "invalid_request");
      if (!cwd) return jsonErr(400, "missing cwd", "invalid_request");
      const mode = parseMode(c.req.query("mode"));
      if (!mode) return jsonErr(400, "invalid mode", "invalid_request");
      const limit = parseLimit(c.req.query("limit"), 100);
      if (limit == null) return jsonErr(400, "invalid limit", "invalid_request");
      return c.json({
        mode,
        cwd,
        commands: listDirectoryActivityCommands(indexDb, { cwd, mode, limit }),
      });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });
}
