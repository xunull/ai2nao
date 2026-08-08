import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { getReplayGapMinutes } from "../appConfig/index.js";
import { getReplaySession, listReplaySessions } from "./queries.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

/** query 的布尔解析(1/true/yes/on → true;0/false/no/off → false;其余 → undefined)。 */
function boolQuery(raw: string | undefined): boolean | undefined {
  if (raw == null) return undefined;
  const t = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(t)) return true;
  if (["0", "false", "no", "off"].includes(t)) return false;
  return undefined;
}

/** windowDays query 校验:给了就必须是正有限数,否则 400。未给 → undefined(用默认)。 */
function parseWindowDays(raw: string | undefined): number | undefined | { error: string } {
  const t = raw?.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) {
    return { error: `invalid windowDays parameter: ${JSON.stringify(t)}` };
  }
  return n;
}

/**
 * 那天回放(桥 T2b)读侧路由。mirror commitBridge/routes.ts。
 *   GET /api/replay/sessions?windowDays=&includeNoCommit=  会话卡片(最新在前)+ skipped
 *   GET /api/replay/session?key=                          某段详情(交织事件流,commit 带 matchedCount)
 * 口径(matchedCount 的 windowFrom 夹逼 + project 隔离)见 queries.ts。
 *
 * 分段阈值来自 app_config 的 `replay.gapMinutes`(设置页可改),**每次请求现读**:
 * 改完设置刷新页面即生效,不用重启 daemon。两个端点必须读同一个值 —— 列表按 A 切、
 * 详情按 B 切的话,列表里的 firstEventKey 在详情侧根本不存在,点进去就是 404。
 */
export function registerReplayRoutes(app: Hono, db: Database.Database): void {
  const gapThresholdMs = () => getReplayGapMinutes(db) * 60_000;

  app.get("/api/replay/sessions", (c) => {
    const windowDays = parseWindowDays(c.req.query("windowDays"));
    if (windowDays != null && typeof windowDays === "object") {
      return jsonErr(400, windowDays.error);
    }
    const includeNoCommit = boolQuery(c.req.query("includeNoCommit")) ?? false;
    try {
      const result = listReplaySessions(db, {
        windowDays,
        includeNoCommit,
        gapThresholdMs: gapThresholdMs(),
      });
      return c.json({ ok: true, ...result });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/api/replay/session", (c) => {
    const key = c.req.query("key")?.trim();
    if (!key) return jsonErr(400, "missing key");
    const windowDays = parseWindowDays(c.req.query("windowDays"));
    if (windowDays != null && typeof windowDays === "object") {
      return jsonErr(400, windowDays.error);
    }
    try {
      const result = getReplaySession(db, {
        key,
        windowDays,
        gapThresholdMs: gapThresholdMs(),
      });
      if (!result) return jsonErr(404, "session not found");
      return c.json({ ok: true, ...result });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });
}
