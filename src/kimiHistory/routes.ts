import type { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  getKimiDashboardSession,
  listKimiDashboardSessions,
  listKimiSessionMessages,
} from "./sessions.js";

/**
 * `/kimi-history` 两个页面的后端。
 *
 * 比 opencode 那套薄得多:kimi 的数据已经在 index.db 里(V55 的 token 索引 +
 * agent_user_messages 的正文),不需要 paths/stateDb/load/normalize 那一整层解析。
 * 这里只是把 `sessions.ts` 的两个查询接到 HTTP 上。
 */

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function registerKimiHistoryRoutes(app: Hono, db?: Database.Database) {
  app.get("/api/kimi-history/sessions", (c) => {
    if (!db) return jsonErr(503, "index db unavailable");
    try {
      const { sessions, diagnostics } = listKimiDashboardSessions(db);
      return c.json({ ok: true, sessions, diagnostics });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/api/kimi-history/sessions/:sessionId", (c) => {
    if (!db) return jsonErr(503, "index db unavailable");
    try {
      const sessionId = decodeURIComponent(c.req.param("sessionId"));
      const session = getKimiDashboardSession(db, sessionId);
      // 会话不存在 → 404。而「会话存在但一条正文都没有」是 200 加空数组 ——
      // 那是真实状态(真库里有一场全是 bash 控制标签的会话),前端走空态,
      // 不能让它长得像「这个会话不存在」。
      if (!session) return jsonErr(404, "session not found");
      return c.json({
        ok: true,
        session,
        messages: listKimiSessionMessages(db, sessionId),
      });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });
}
