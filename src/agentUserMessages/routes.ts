import type { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  getUserMessageRaw,
  searchUserMessages,
  userMessageAnalytics,
  userMessageList,
  userMessageTimeline,
  type SearchRoleFilter,
  type TimelineWindow,
} from "./queries.js";
import { isWindowKey } from "../timeWindow/types.js";
import type { AgentUserMessageSource } from "./types.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

/**
 * 搜索的 `source=` 白名单。**必须与 AgentUserMessageSource 手工保持同步** ——
 * 往那个联合类型加成员不会让 tsc 报到这里(协变位置)。kimi 就是这么漏的:
 * 它入库很久了,却一直不在这个集合里,搜索按 source 筛 kimi 会被当成非法值。
 */
const SOURCES = new Set<AgentUserMessageSource>([
  "claude",
  "codex",
  "opencode",
  "kimi",
  "hermes",
]);
const ROLE_FILTERS = new Set<string>(["user", "assistant", "all"]);

/**
 * agent 用户消息搜索 + 原文审计。
 *   GET /api/agent-user-messages/search?q=&source=&from=&to=&limit=&role=
 *   GET /api/agent-user-messages/:id/raw
 * raw_text/raw_payload_json 只在 /:id/raw 返回(审计),搜索结果只给 cleaned 片段。
 *
 * `role` 缺省 = "user",与 V53 之前逐条一致 —— 不传这个参数的老调用方
 * (以及所有已存在的书签/链接)行为完全不变。
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
    const roleRaw = c.req.query("role")?.trim();
    if (roleRaw && !ROLE_FILTERS.has(roleRaw)) {
      return jsonErr(400, `invalid role parameter: ${JSON.stringify(roleRaw)}`);
    }
    try {
      const hits = searchUserMessages(db, {
        q,
        source: sourceRaw as AgentUserMessageSource | undefined,
        from,
        to,
        limit,
        role: roleRaw as SearchRoleFilter | undefined,
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

  // 窗口内浏览(全源、最新在前、keyset 分页)。window 校验与 /analytics 一致。
  app.get("/api/agent-user-messages/list", (c) => {
    const windowRaw = c.req.query("window")?.trim();
    const beforeRaw = c.req.query("before")?.trim() || undefined;
    const beforeIdRaw = c.req.query("beforeId")?.trim() || undefined;
    const limitRaw = c.req.query("limit")?.trim();
    if (windowRaw && windowRaw !== "today" && !isWindowKey(windowRaw)) {
      return jsonErr(400, `invalid window parameter: ${JSON.stringify(windowRaw)}`);
    }
    const window: TimelineWindow =
      windowRaw === "today"
        ? "today"
        : windowRaw && isWindowKey(windowRaw)
          ? windowRaw
          : "1w";
    // 复合游标必须成对。
    if ((beforeRaw === undefined) !== (beforeIdRaw === undefined)) {
      return jsonErr(400, "before and beforeId must be provided together");
    }
    let before: string | undefined;
    let beforeId: number | undefined;
    if (beforeRaw !== undefined && beforeIdRaw !== undefined) {
      before = beforeRaw;
      beforeId = Number(beforeIdRaw);
      if (!Number.isInteger(beforeId) || beforeId <= 0) {
        return jsonErr(400, `invalid beforeId parameter: ${JSON.stringify(beforeIdRaw)}`);
      }
    }
    let limit: number | undefined;
    if (limitRaw) {
      limit = Number(limitRaw);
      if (!Number.isFinite(limit) || limit <= 0) {
        return jsonErr(400, `invalid limit parameter: ${JSON.stringify(limitRaw)}`);
      }
    }
    try {
      const page = userMessageList(db, { window, before, beforeId, limit });
      return c.json({ ok: true, ...page });
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
