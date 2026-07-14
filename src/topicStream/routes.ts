import type { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  DEFAULT_TAXONOMY,
  OTHER_CATEGORY,
  taxonomyLegend,
} from "./classify.js";
import {
  DEFAULT_SESSION_GAP_MINUTES,
  clearTopicTaxonomy,
  getTopicTaxonomy,
  setTopicTaxonomy,
} from "../appConfig/index.js";
import { readTopicStreamConfig, resolveTopicStreamConfig } from "./config.js";
import { getTopicStreamDrilldown, getTopicStreamMatrix, type TopicGrain } from "./queries.js";
import { CHROME_SOURCE, GIT_SOURCE, CONVERSATION_SOURCE, getTopicStreamStatus } from "./rebuild.js";
import { conversationLegend } from "./conversation.js";

/** Names of the built-in categories — used to tell "the user's own" from "merged in". */
const DEFAULT_NAMES = new Set(DEFAULT_TAXONOMY.map((c) => c.name));

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

type Ctx = { req: { query: (k: string) => string | undefined } };

function profileOf(c: Ctx): string {
  const p = (c.req.query("profile") ?? "Default").trim();
  return p.length > 0 ? p : "Default";
}

/** Topic sources: chrome (browsing), git (commits), conversation (AI chats). */
function sourceOf(c: Ctx): string {
  const s = (c.req.query("source") ?? CHROME_SOURCE).trim() || CHROME_SOURCE;
  if (s !== CHROME_SOURCE && s !== GIT_SOURCE && s !== CONVERSATION_SOURCE) {
    throw new Error(`invalid source '${s}' (use chrome | git | conversation)`);
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
    try {
      const source = sourceOf(c);
      // Conversation bands are the frozen codebook labels; color keyed by cluster_id
      // (stable, thickness-independent). chrome/git keep the taxonomy legend.
      if (source === CONVERSATION_SOURCE) {
        return c.json({ configOk: true, source, categories: conversationLegend(db) });
      }
      const cfg = resolveTopicStreamConfig(db);
      if (!cfg.ok) {
        return c.json({
          configOk: false,
          source,
          configPath: cfg.path,
          issues: cfg.issues,
          categories: taxonomyLegend(),
        });
      }
      return c.json({
        configOk: true,
        source,
        configPath: cfg.path,
        configExists: cfg.exists,
        categories: taxonomyLegend(cfg.categories),
      });
    } catch (e) {
      return jsonErr(statusCode(e), String(e));
    }
  });

  /**
   * The taxonomy editor's view. `own` is what the user actually stores; `builtin`
   * is every default they have NOT overridden, sent read-only so the editor can
   * show the full picture without saving the defaults back — which would freeze
   * them and cut the user off from future updates to the built-in list.
   */
  app.get("/api/topics/taxonomy", (c) => {
    try {
      const stored = getTopicTaxonomy(db);
      const fromFile = stored ? null : readTopicStreamConfig();
      // Before the first save, the file's own categories ARE the user's — but the
      // file reader hands back the merged list, so subtract the built-ins to
      // recover just their additions.
      const own = stored
        ? stored.categories
        : fromFile?.ok
          ? fromFile.categories.filter((c) => !DEFAULT_NAMES.has(c.name))
          : [];
      const ownNames = new Set(own.map((c) => c.name));
      return c.json({
        source: stored ? "db" : fromFile?.ok && fromFile.exists ? "file" : "default",
        gapMinutes:
          stored?.gapMinutes ?? (fromFile?.ok ? fromFile.gapMinutes : DEFAULT_SESSION_GAP_MINUTES),
        own,
        builtin: DEFAULT_TAXONOMY.filter((d) => !ownNames.has(d.name)),
        otherCategory: OTHER_CATEGORY,
      });
    } catch (e) {
      return jsonErr(statusCode(e), String(e));
    }
  });

  // PATCH, not PUT: PUT is absent from the CORS allowMethods list
  // (src/serve/app.ts:262), so a browser would fail the preflight while
  // app.request() in tests sails straight through — a bug no unit test can see.
  //
  // Saving changes the taxonomy hash, so the topic river reports
  // rule_version_mismatch ("需要重建") on its own; no extra signal needed here.
  app.patch("/api/topics/taxonomy", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonErr(400, "invalid JSON body");
    }
    const { categories, gapMinutes } = (body ?? {}) as {
      categories?: unknown;
      gapMinutes?: unknown;
    };
    try {
      const saved = setTopicTaxonomy(db, categories, gapMinutes);
      const ownNames = new Set(saved.categories.map((x) => x.name));
      return c.json({
        source: "db",
        gapMinutes: saved.gapMinutes,
        own: saved.categories,
        builtin: DEFAULT_TAXONOMY.filter((d) => !ownNames.has(d.name)),
        otherCategory: OTHER_CATEGORY,
      });
    } catch (e) {
      return jsonErr(400, e instanceof Error ? e.message : String(e));
    }
  });

  // Forget the stored taxonomy and fall back to config.json (or the built-ins).
  app.delete("/api/topics/taxonomy", (c) => {
    try {
      clearTopicTaxonomy(db);
      return c.json({ ok: true });
    } catch (e) {
      return jsonErr(statusCode(e), String(e));
    }
  });
}
