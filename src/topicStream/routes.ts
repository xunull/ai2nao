import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { taxonomyLegend } from "./classify.js";
import { readTopicStreamConfig } from "./config.js";
import { getTopicStreamDrilldown, getTopicStreamMatrix, type TopicGrain } from "./queries.js";
import { CHROME_SOURCE, GIT_SOURCE, getTopicStreamStatus } from "./rebuild.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

type Ctx = { req: { query: (k: string) => string | undefined } };

function profileOf(c: Ctx): string {
  const p = (c.req.query("profile") ?? "Default").trim();
  return p.length > 0 ? p : "Default";
}

/** Topic sources: chrome (browsing) and git (commits). Reject anything else loudly. */
function sourceOf(c: Ctx): string {
  const s = (c.req.query("source") ?? CHROME_SOURCE).trim() || CHROME_SOURCE;
  if (s !== CHROME_SOURCE && s !== GIT_SOURCE) {
    throw new Error(`invalid source '${s}' (use chrome | git)`);
  }
  return s;
}

function dateQuery(c: Ctx, key: string): string | null {
  const raw = (c.req.query(key) ?? "").trim();
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`invalid ${key} (use YYYY-MM-DD)`);
  return raw;
}

function parseGrain(raw: string | undefined): TopicGrain {
  return raw === "week" || raw === "month" ? raw : "day";
}

function statusCode(e: unknown): number {
  return e instanceof Error && /^invalid /.test(e.message) ? 400 : 500;
}

export function registerTopicStreamRoutes(app: Hono, db: Database.Database): void {
  app.get("/api/topics/stream", (c) => {
    try {
      const source = sourceOf(c);
      const profile = profileOf(c);
      const grain = parseGrain(c.req.query("grain"));
      const from = dateQuery(c, "from");
      const to = dateQuery(c, "to");
      const matrix = getTopicStreamMatrix(db, { source, profile, grain, from, to });
      return c.json({
        source,
        profile,
        grain,
        from,
        to,
        timezone: "local",
        ...matrix,
        status: getTopicStreamStatus(db, source, profile),
      });
    } catch (e) {
      return jsonErr(statusCode(e), String(e));
    }
  });

  app.get("/api/topics/stream/drilldown", (c) => {
    try {
      const source = sourceOf(c);
      const profile = profileOf(c);
      const category = (c.req.query("category") ?? "").trim();
      if (!category) throw new Error("invalid category (required)");
      const bucket = (c.req.query("bucket") ?? "").trim();
      if (!bucket) throw new Error("invalid bucket (required)");
      const grain = parseGrain(c.req.query("grain"));
      const cursor = (c.req.query("cursor") ?? "").trim() || null;
      const perPage = parseInt(c.req.query("per_page") ?? "50", 10) || 50;
      const result = getTopicStreamDrilldown(db, {
        source,
        profile,
        category,
        bucket,
        grain,
        cursor,
        perPage,
      });
      return c.json({
        // event_time is source-agnostic Unix ms (chrome converts WebKit µs at derive).
        items: result.items.map((r) => ({ ...r, event_time_unix_ms: r.event_time })),
        next_cursor: result.nextCursor,
      });
    } catch (e) {
      return jsonErr(statusCode(e), String(e));
    }
  });

  app.get("/api/topics/status", (c) => {
    try {
      const source = sourceOf(c);
      const profile = profileOf(c);
      return c.json(getTopicStreamStatus(db, source, profile));
    } catch (e) {
      return jsonErr(statusCode(e), String(e));
    }
  });

  app.get("/api/topics/categories", (c) => {
    const cfg = readTopicStreamConfig();
    if (!cfg.ok) {
      return c.json({
        configOk: false,
        configPath: cfg.path,
        issues: cfg.issues,
        categories: taxonomyLegend(),
      });
    }
    return c.json({
      configOk: true,
      configPath: cfg.path,
      configExists: cfg.exists,
      categories: taxonomyLegend(cfg.categories),
    });
  });
}
