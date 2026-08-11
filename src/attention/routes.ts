import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { getAttentionDay, UNSUPPORTED_SOURCES } from "./queries.js";
import { localDayOf } from "./spans.js";
import { getAttentionStatus } from "./status.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function registerAttentionRoutes(app: Hono, db: Database.Database) {
  /**
   * Why the page might be empty, in a form the UI can act on.
   *
   * Four of the five states are reachable by default — the task registers
   * disabled and Full Disk Access starts ungranted — so "empty" is the normal
   * first experience. Collapsing them into one blank screen is how a source
   * ends up 22 days behind without anyone noticing.
   */
  app.get("/api/attention/status", (c) => {
    const status = getAttentionStatus(db);
    return c.json({
      ok: status.status === "ok",
      status,
      unsupportedSources: UNSUPPORTED_SOURCES,
    });
  });

  app.get("/api/attention/day", (c) => {
    const raw = c.req.query("day");
    const day = raw && raw.length > 0 ? raw : localDayOf(Date.now());
    if (!DAY_RE.test(day)) {
      return jsonErr(400, `day must look like YYYY-MM-DD, got ${JSON.stringify(day)}`);
    }
    const data = getAttentionDay(db, day);
    return c.json({ ok: true, day: data, unsupportedSources: UNSUPPORTED_SOURCES });
  });

  /** Days that actually hold spans, newest first — drives the date picker. */
  app.get("/api/attention/days", (c) => {
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "60", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 400) : 60;
    const rows = db
      .prepare(
        `SELECT local_day AS day, COUNT(*) AS spans, SUM(duration_ms) AS total_ms
           FROM attention_focus_spans
          GROUP BY local_day
          ORDER BY local_day DESC
          LIMIT ?`
      )
      .all(limit) as { day: string; spans: number; total_ms: number }[];
    return c.json({ ok: true, days: rows });
  });
}
