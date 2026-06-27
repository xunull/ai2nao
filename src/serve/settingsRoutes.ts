import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { getScanRoots, setScanRoots } from "../appConfig/index.js";
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
  app.get("/api/settings", (c) => {
    return c.json({ scanRoots: getScanRoots(db), github: githubDto() });
  });

  // PATCH /api/settings { scanRoots: string[] } — full-array replace; [] clears.
  app.patch("/api/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonErr(400, "invalid JSON body");
    }
    const scanRoots = (body as { scanRoots?: unknown })?.scanRoots;
    if (scanRoots === undefined) {
      return c.json({ scanRoots: getScanRoots(db), github: githubDto() });
    }
    if (!Array.isArray(scanRoots)) {
      return jsonErr(400, "scanRoots must be an array");
    }
    try {
      // setScanRoots error messages echo the user's own paths (not server paths) — safe.
      const stored = setScanRoots(db, scanRoots as string[]);
      return c.json({ scanRoots: stored, github: githubDto() });
    } catch (e) {
      return jsonErr(400, e instanceof Error ? e.message : "invalid scan roots");
    }
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
