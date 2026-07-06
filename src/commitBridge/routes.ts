import type { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  commitConversation,
  commitCoverage,
  listBridgeRepos,
  listCommits,
} from "./queries.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

/**
 * 对话↔提交桥(T1b)读侧路由。
 *   GET /api/commit-bridge/repos                                  仓库下拉 + 全局 coverage 头条
 *   GET /api/commit-bridge/commits?repo=&before=&beforeHash=&limit=  commit 列表(keyset)+ 当前筛选 coverage
 *   GET /api/commit-bridge/commit?repo=&hash=                     单 commit 的窗口对话(未找到 404)
 * 关联口径(启发式、非因果)见 queries.ts。mirror agentUserMessages/routes.ts。
 */
export function registerCommitBridgeRoutes(
  app: Hono,
  db: Database.Database
): void {
  app.get("/api/commit-bridge/repos", (c) => {
    try {
      const repos = listBridgeRepos(db);
      // 头条 coverage 不筛仓库(全局)。
      const coverage = commitCoverage(db);
      return c.json({ ok: true, repos, coverage });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/api/commit-bridge/commits", (c) => {
    const repo = c.req.query("repo")?.trim() || undefined;
    const beforeRaw = c.req.query("before")?.trim() || undefined;
    const beforeHashRaw = c.req.query("beforeHash")?.trim() || undefined;
    const limitRaw = c.req.query("limit")?.trim();

    // 复合游标必须成对(author_date_utc 非唯一,靠 commit_hash 破平)。
    if ((beforeRaw === undefined) !== (beforeHashRaw === undefined)) {
      return jsonErr(400, "before and beforeHash must be provided together");
    }
    let limit: number | undefined;
    if (limitRaw) {
      limit = Number(limitRaw);
      if (!Number.isFinite(limit) || limit <= 0) {
        return jsonErr(400, `invalid limit parameter: ${JSON.stringify(limitRaw)}`);
      }
    }
    try {
      const page = listCommits(db, {
        repo,
        before: beforeRaw,
        beforeHash: beforeHashRaw,
        limit,
      });
      // coverage 跟随当前 repo 筛选(repo 未给 → 全局)。
      const coverage = commitCoverage(db, { repo });
      return c.json({ ok: true, ...page, coverage });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/api/commit-bridge/commit", (c) => {
    const repo = c.req.query("repo")?.trim();
    const hash = c.req.query("hash")?.trim();
    if (!repo) return jsonErr(400, "missing repo");
    if (!hash) return jsonErr(400, "missing hash");
    try {
      const result = commitConversation(db, { repo, hash });
      if (!result) return jsonErr(404, "commit not found");
      return c.json({ ok: true, ...result });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });
}
