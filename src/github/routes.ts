/**
 * Hono handlers for the GitHub personal mirror. We export registered routes
 * as a single `registerGithubRoutes(app, db)` function so `src/serve/app.ts`
 * stays a thin list of `app.get(...)` equivalents — mirroring the
 * `registerLlmChatRoutes` pattern already in use.
 *
 * Endpoint map (all read-only for P0):
 *   GET /api/github/status       → token + sync-state banner
 *   GET /api/github/repos        → keyset-paginated owned repos + commit counts
 *   GET /api/github/stars        → keyset-paginated starred repos
 *   GET /api/github/heatmap      → [{day, repo_count, star_count}]
 *   GET /api/github/sync-state   → raw gh_sync_state bag
 *
 * Tag pivot (V1 — stars only):
 *   GET /api/github/tags/top     → tag ranking
 *   GET /api/github/tags/heatmap → tag × time 2D heatmap
 *   GET /api/github/tags/repos   → keyset-paginated filtered repos
 *   GET /api/github/tags/aliases → read-only list of gh_tag_alias
 *
 * Radar (local-only user memory; never writes to GitHub):
 *   GET  /api/github/radar                → overview DTO
 *   POST /api/github/radar/notes/:repo_id → upsert local note/status
 *   GET  /api/github/radar/insights       → materialized insight snapshot
 *   POST /api/github/radar/insights/refresh → refresh insight snapshot
 *   POST /api/github/radar/insights/feedback → record insight feedback
 */

import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { githubTokenStatus } from "./config.js";
import {
  countRepos,
  countStars,
  getHeatmapBuckets,
  getSyncState,
  listRepos,
  listStars,
} from "./queries.js";
import {
  assertValidRepoId,
  getRadarOverview,
  isStarNoteStatus,
  upsertStarNote,
} from "./radar.js";
import {
  getRadarInsights,
  refreshRadarInsights,
  saveRadarInsightFeedback,
} from "./radarInsights/snapshot.js";
import { isRadarInsightFeedback } from "./radarInsights/types.js";
import {
  getTagTimeHeatmap,
  getTopTags,
  listTagAliases,
  listTaggedRepos,
} from "./tags.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function registerGithubRoutes(app: Hono, db: Database.Database): void {
  app.get("/api/github/status", (c) => {
    try {
      const token = githubTokenStatus();
      const sync = getSyncState(db);
      return c.json({
        token,
        sync,
        counts: { repos: countRepos(db), stars: countStars(db) },
      });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/github/sync-state", (c) => {
    try {
      return c.json(getSyncState(db));
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/github/repos", (c) => {
    try {
      const rawCursor = c.req.query("cursor");
      const cursor =
        rawCursor && /^\d+$/.test(rawCursor) ? parseInt(rawCursor, 10) : null;
      const perPage = Math.min(
        100,
        Math.max(1, parseInt(c.req.query("per_page") ?? "30", 10) || 30)
      );
      const sortRaw = c.req.query("sort");
      const sort =
        sortRaw === "updated_at" || sortRaw === "pushed_at"
          ? sortRaw
          : "created_at";
      const { items, nextCursor } = listRepos(db, { cursor, perPage, sort });
      return c.json({ items, next_cursor: nextCursor });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/github/stars", (c) => {
    try {
      const cursor = (c.req.query("cursor") ?? "").trim() || null;
      const perPage = Math.min(
        100,
        Math.max(1, parseInt(c.req.query("per_page") ?? "30", 10) || 30)
      );
      const { items, nextCursor } = listStars(db, { cursor, perPage });
      return c.json({ items, next_cursor: nextCursor });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/github/heatmap", (c) => {
    try {
      const since = (c.req.query("since") ?? "").trim() || null;
      const until = (c.req.query("until") ?? "").trim() || null;
      const buckets = getHeatmapBuckets(db, since, until);
      return c.json({ buckets });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  // ---------- Open-source radar ----------

  app.get("/api/github/radar", (c) => {
    try {
      const clusterLimit = parsePositiveInt(c.req.query("cluster_limit"));
      const queueLimit = parsePositiveInt(c.req.query("queue_limit"));
      return c.json(getRadarOverview(db, { clusterLimit, queueLimit }));
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.post("/api/github/radar/notes/:repo_id", async (c) => {
    try {
      const repoId = parseInt(c.req.param("repo_id"), 10);
      assertValidRepoId(repoId);
      const body = (await c.req.json().catch(() => null)) as
        | { reason?: unknown; status?: unknown; last_reviewed_at?: unknown }
        | null;
      if (!body || !isStarNoteStatus(body.status)) {
        return jsonErr(
          400,
          "status must be one of: new, reviewed, try_next, ignore, retired"
        );
      }
      const reason =
        typeof body.reason === "string" || body.reason == null
          ? body.reason
          : String(body.reason);
      const lastReviewedAt =
        typeof body.last_reviewed_at === "string" || body.last_reviewed_at == null
          ? body.last_reviewed_at
          : String(body.last_reviewed_at);
      const note = upsertStarNote(db, {
        repoId,
        reason,
        status: body.status,
        lastReviewedAt,
      });
      return c.json({ note });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/repo_id must be a positive integer/.test(msg)) {
        return jsonErr(400, msg);
      }
      return jsonErr(500, msg);
    }
  });

  app.get("/api/github/radar/insights", (c) => {
    try {
      return c.json(getRadarInsights(db));
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.post("/api/github/radar/insights/refresh", (c) => {
    try {
      const result = refreshRadarInsights(db);
      if (!result.ok && result.status === "refresh_in_progress") {
        return c.json(result, 409);
      }
      if (!result.ok) {
        return c.json(result, 500);
      }
      return c.json(result);
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.post("/api/github/radar/insights/feedback", async (c) => {
    try {
      const body = (await c.req.json().catch(() => null)) as
        | {
            target_type?: unknown;
            target_id?: unknown;
            feedback?: unknown;
            insight_fingerprint?: unknown;
            repo_id?: unknown;
            terms?: unknown;
          }
        | null;
      if (
        !body ||
        (body.target_type !== "insight" && body.target_type !== "repo") ||
        typeof body.target_id !== "string" ||
        !isRadarInsightFeedback(body.feedback)
      ) {
        return jsonErr(
          400,
          "target_type, target_id, and feedback are required"
        );
      }
      const repoId =
        typeof body.repo_id === "number" && Number.isInteger(body.repo_id)
          ? body.repo_id
          : null;
      const terms = Array.isArray(body.terms)
        ? body.terms.filter((t): t is string => typeof t === "string")
        : [];
      const saved = saveRadarInsightFeedback(db, {
        target_type: body.target_type,
        target_id: body.target_id,
        feedback: body.feedback,
        insight_fingerprint:
          typeof body.insight_fingerprint === "string"
            ? body.insight_fingerprint
            : null,
        repo_id: repoId,
        terms,
      });
      return c.json(saved);
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  // ---------- Tag pivot ----------

  app.get("/api/github/tags/top", (c) => {
    try {
      const limit = Math.min(
        500,
        Math.max(1, parseInt(c.req.query("limit") ?? "50", 10) || 50)
      );
      const windowRaw = c.req.query("window");
      const window = windowRaw === "12m" ? "12m" : "all";
      const includeLanguageFallback = c.req.query("include_language") === "1";
      const items = getTopTags(db, { limit, window, includeLanguageFallback });
      return c.json({ items });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/github/tags/heatmap", (c) => {
    try {
      const topN = Math.min(
        50,
        Math.max(1, parseInt(c.req.query("top") ?? "15", 10) || 15)
      );
      const grainRaw = c.req.query("grain");
      const grain =
        grainRaw === "quarter" || grainRaw === "year" ? grainRaw : "month";
      const from = (c.req.query("from") ?? "").trim() || null;
      const to = (c.req.query("to") ?? "").trim() || null;
      const includeLanguageFallback = c.req.query("include_language") === "1";
      const tagsCsv = (c.req.query("tags") ?? "").trim();
      const tags =
        tagsCsv.length > 0
          ? tagsCsv
              .split(",")
              .map((t) => t.trim())
              .filter((t) => t.length > 0)
          : undefined;
      const result = getTagTimeHeatmap(db, {
        topN,
        grain,
        from,
        to,
        includeLanguageFallback,
        tags,
      });
      return c.json(result);
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/github/tags/repos", (c) => {
    try {
      const tagsCsv = (c.req.query("tags") ?? "").trim();
      if (!tagsCsv) {
        return c.json({ items: [], next_cursor: null });
      }
      const tags = tagsCsv
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const modeRaw = c.req.query("mode");
      const mode = modeRaw === "and" ? "and" : "or";
      const from = (c.req.query("from") ?? "").trim() || null;
      const to = (c.req.query("to") ?? "").trim() || null;
      const cursor = (c.req.query("cursor") ?? "").trim() || null;
      const perPage = Math.min(
        100,
        Math.max(1, parseInt(c.req.query("per_page") ?? "30", 10) || 30)
      );
      const { items, nextCursor } = listTaggedRepos(db, {
        tags,
        mode,
        from,
        to,
        cursor,
        perPage,
      });
      return c.json({ items, next_cursor: nextCursor });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/github/tags/aliases", (c) => {
    try {
      const sourceRaw = c.req.query("source");
      const source =
        sourceRaw === "preset" || sourceRaw === "user" ? sourceRaw : undefined;
      const items = listTagAliases(db, source);
      return c.json({ items });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
