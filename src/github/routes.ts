/**
 * Hono handlers for the GitHub personal mirror. We export registered routes
 * as a single `registerGithubRoutes(app, db)` function so `src/serve/app.ts`
 * stays a thin list of `app.get(...)` equivalents — mirroring the
 * `registerLlmChatRoutes` pattern already in use.
 *
 * Endpoint map (all read-only for P0):
 *   GET /api/github/status     → token + sync-state banner
 *   GET /api/github/repos      → keyset-paginated owned repos + commit counts
 *   GET /api/github/stars      → keyset-paginated starred repos
 *   GET /api/github/heatmap    → [{day, repo_count, star_count}]
 *   GET /api/github/sync-state → raw gh_sync_state bag
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
}
