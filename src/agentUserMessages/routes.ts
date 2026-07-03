import type { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  getUserMessageRaw,
  searchUserMessages,
  userMessageAnalytics,
} from "./queries.js";
import type { AgentUserMessageSource } from "./types.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

const SOURCES = new Set<AgentUserMessageSource>(["claude", "codex", "opencode"]);

/**
 * agent 用户消息搜索 + 原文审计。
 *   GET /api/agent-user-messages/search?q=&source=&from=&to=&limit=
 *   GET /api/agent-user-messages/:id/raw
 * raw_text/raw_payload_json 只在 /:id/raw 返回(审计),搜索结果只给 cleaned 片段。
 */
export function registerAgentUserMessagesRoutes(
  app: Hono,
  db: Database.Database
): void {
  app.get("/api/agent-user-messages/search", (c) => {
    const q = c.req.query("q")?.trim() ?? "";
    const sourceRaw = c.req.query("source")?.trim();
    const from = c.req.query("from")?.trim() || undefined;
    const to = c.req.query("to")?.trim() || undefined;
    const limitRaw = c.req.query("limit")?.trim();

    if (sourceRaw && !SOURCES.has(sourceRaw as AgentUserMessageSource)) {
      return jsonErr(400, `invalid source parameter: ${JSON.stringify(sourceRaw)}`);
    }
    let limit: number | undefined;
    if (limitRaw) {
      limit = Number(limitRaw);
      if (!Number.isFinite(limit) || limit <= 0) {
        return jsonErr(400, `invalid limit parameter: ${JSON.stringify(limitRaw)}`);
      }
    }
    try {
      const hits = searchUserMessages(db, {
        q,
        source: sourceRaw as AgentUserMessageSource | undefined,
        from,
        to,
        limit,
      });
      return c.json({ ok: true, hits });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/api/agent-user-messages/analytics", (c) => {
    const sourceRaw = c.req.query("source")?.trim();
    const from = c.req.query("from")?.trim() || undefined;
    const to = c.req.query("to")?.trim() || undefined;
    if (sourceRaw && !SOURCES.has(sourceRaw as AgentUserMessageSource)) {
      return jsonErr(400, `invalid source parameter: ${JSON.stringify(sourceRaw)}`);
    }
    try {
      const analytics = userMessageAnalytics(db, {
        source: sourceRaw as AgentUserMessageSource | undefined,
        from,
        to,
      });
      return c.json({ ok: true, ...analytics });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/api/agent-user-messages/:id/raw", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return jsonErr(400, "invalid id");
    }
    try {
      const raw = getUserMessageRaw(db, id);
      if (!raw) return jsonErr(404, "not found");
      return c.json({ ok: true, raw });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });
}
