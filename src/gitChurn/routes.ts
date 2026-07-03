import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { windowToRange } from "../timeWindow/bucket.js";
import { isWindowKey } from "../timeWindow/types.js";
import { buildProjectOutput } from "./queries.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

/**
 * GET /api/project-output?window=1w
 *   Per-repo token-vs-git-output analysis (token/line is a labeled efficiency
 *   lens, not a value metric — see queries.ts / analysis.ts).
 */
export function registerGitChurnRoutes(app: Hono, db: Database.Database): void {
  app.get("/api/project-output", (c) => {
    const windowRaw = c.req.query("window")?.trim() || "1w";
    if (!isWindowKey(windowRaw)) {
      return jsonErr(
        400,
        `invalid window parameter: expected one of 1d|3d|1w|2w|1m|3m|6m, got ${JSON.stringify(windowRaw)}`
      );
    }
    try {
      const range = windowToRange(windowRaw);
      const result = buildProjectOutput(db, range);
      return c.json({ window: windowRaw, ...result });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return jsonErr(500, message);
    }
  });
}
