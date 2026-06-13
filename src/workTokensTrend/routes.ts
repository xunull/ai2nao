import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { responseToJson } from "./json.js";
import { generateTrend } from "./service.js";
import { isWindowKey } from "./types.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function registerWorkTokensTrendRoutes(
  app: Hono,
  db: Database.Database
): void {
  app.get("/api/work-tokens-trend", (c) => {
    const windowRaw = c.req.query("window")?.trim();
    const monthRaw = c.req.query("month")?.trim();
    try {
      // Narrow window at the boundary so the service signature can stay
      // strict (WindowKey union). Invalid values fall through to the
      // service's own isWindowKey check → 400.
      const window = windowRaw && isWindowKey(windowRaw) ? windowRaw : undefined;
      if (windowRaw && !window) {
        return jsonErr(
          400,
          `invalid window parameter: expected one of 1d|3d|1w|2w|1m|3m|6m, got ${JSON.stringify(windowRaw)}`
        );
      }
      const result = generateTrend(db, { window, month: monthRaw || undefined });
      return c.json(responseToJson(result));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Param validation errors → 400; everything else → 500. The service
      // surface throws explicit "invalid ..." messages for bad input.
      if (/invalid|older than|expected/i.test(message)) {
        return jsonErr(400, message);
      }
      return jsonErr(500, message);
    }
  });
}
