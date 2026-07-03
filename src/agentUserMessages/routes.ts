import type { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  getUserMessageRaw,
  searchUserMessages,
  userMessageAnalytics,
  userMessageTimeline,
  type TimelineWindow,
} from "./queries.js";
import { isWindowKey } from "../timeWindow/types.js";
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
    const windowRaw = c.req.query("window")?.trim();
    if (sourceRaw && !SOURCES.has(sourceRaw as AgentUserMessageSource)) {
      return jsonErr(400, `invalid source parameter: ${JSON.stringify(sourceRaw)}`);
    }
    if (windowRaw && windowRaw !== "today" && !isWindowKey(windowRaw)) {
      return jsonErr(400, `invalid window parameter: ${JSON.stringify(windowRaw)}`);
    }
    const window: TimelineWindow =
      windowRaw === "today"
        ? "today"
        : windowRaw && isWindowKey(windowRaw)
          ? windowRaw
          : "1w";
    try {
      const source = sourceRaw as AgentUserMessageSource | undefined;
      // D5:allTimeTotals(全表,顶部「累计」条)与 timeline(当前窗口图)分开。
      const allTimeTotals = userMessageAnalytics(db, { source }).totals;
      const timeline = userMessageTimeline(db, { window, source });
      return c.json({ ok: true, allTimeTotals, timeline });
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
