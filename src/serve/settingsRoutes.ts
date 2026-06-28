import type { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  getScanRoots,
  setScanRoots,
  getScanMaxDepth,
  setScanMaxDepth,
  getScanMaxDocs,
  setScanMaxDocs,
} from "../appConfig/index.js";
import {
  deleteGithubConfig,
  githubTokenStatus,
  writeGithubConfig,
} from "../github/config.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

/** Narrow secret DTO — only set/source, NEVER the token or the local file path. */
function githubDto(): { set: boolean; source: "env" | "file" | null } {
  const s = githubTokenStatus();
  return { set: s.configured, source: s.source };
}

/**
 * Settings API. Non-secret config (scan roots) lives in app_config; the GitHub
 * token lives in its 0600 file (writeGithubConfig). The token is never returned;
 * only `{ set, source }`. Uses PATCH (CORS allowMethods has no PUT).
 */
export function registerSettingsRoutes(app: Hono, db: Database.Database): void {
  const settingsDto = () => ({
    scanRoots: getScanRoots(db),
    scanMaxDepth: getScanMaxDepth(db),
    scanMaxDocs: getScanMaxDocs(db),
    github: githubDto(),
  });

  app.get("/api/settings", (c) => c.json(settingsDto()));

  // PATCH /api/settings { scanRoots?: string[]; scanMaxDepth?: number } — partial.
  // scanRoots is a full-array replace ([] clears); scanMaxDepth is the depth brake.
  app.patch("/api/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonErr(400, "invalid JSON body");
    }
    const { scanRoots, scanMaxDepth, scanMaxDocs } = body as {
      scanRoots?: unknown;
      scanMaxDepth?: unknown;
      scanMaxDocs?: unknown;
    };
    try {
      if (scanRoots !== undefined) {
        if (!Array.isArray(scanRoots)) return jsonErr(400, "scanRoots must be an array");
        // setScanRoots error messages echo the user's own paths (not server paths) — safe.
        setScanRoots(db, scanRoots as string[]);
      }
      if (scanMaxDepth !== undefined) {
        if (typeof scanMaxDepth !== "number") return jsonErr(400, "scanMaxDepth must be a number");
        setScanMaxDepth(db, scanMaxDepth);
      }
      if (scanMaxDocs !== undefined) {
        if (typeof scanMaxDocs !== "number") return jsonErr(400, "scanMaxDocs must be a number");
        setScanMaxDocs(db, scanMaxDocs);
      }
    } catch (e) {
      return jsonErr(400, e instanceof Error ? e.message : "invalid settings");
    }
    return c.json(settingsDto());
  });

  // PATCH /api/settings/secret/github { token } — write the 0600 token file.
  app.patch("/api/settings/secret/github", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonErr(400, "invalid JSON body");
    }
    const token = (body as { token?: unknown })?.token;
    if (typeof token !== "string" || token.trim() === "") {
      return jsonErr(400, "token is required");
    }
    try {
      writeGithubConfig({ token: token.trim() });
    } catch {
      // Generic error — the raw fs error would leak the absolute config path.
      return jsonErr(500, "failed to write token");
    }
    return c.json({ github: githubDto() });
  });

  // DELETE the token file. Env var (if set) still wins, so set may stay true.
  app.delete("/api/settings/secret/github", (c) => {
    try {
      deleteGithubConfig();
    } catch {
      return jsonErr(500, "failed to delete token");
    }
    return c.json({ github: githubDto() });
  });
}
