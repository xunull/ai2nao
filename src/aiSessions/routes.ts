import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { windowToRange } from "../timeWindow/bucket.js";
import { isWindowKey, WINDOW_KEYS } from "../timeWindow/types.js";
import { dailySessions, daySessionDetail } from "./queries.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

/** 本地日历日,与 queries 的分桶同口径。 */
function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 参数名用 `window` 而不是 `range` —— 仓库既有约定
 * (`workTokensTrend/routes.ts:16` 等),且 `WINDOW_KEYS` 已经定义好合法值。
 * 注意 `3m` 在本仓库是 **90 天**(`timeWindow/types.ts:52`),不是自然三个月。
 */
export function registerAiSessionsRoutes(app: Hono, db: Database.Database): void {
  app.get("/api/ai-sessions", (c) => {
    const raw = c.req.query("window")?.trim() || "3m";
    if (!isWindowKey(raw)) {
      return jsonErr(
        400,
        `invalid window parameter: expected one of ${WINDOW_KEYS.join("|")}, got ${JSON.stringify(raw)}`
      );
    }
    try {
      const { from, to } = windowToRange(raw);
      const result = dailySessions(db, { from: localDay(from), to: localDay(to) });
      return c.json({
        window: raw,
        from: localDay(from),
        to: localDay(to),
        ...result,
        // 覆盖面必须随数字一起下发 —— 不写明就又是一个「读起来像全部、
        // 其实不是」的数(排行页的活跃时长列刚栽过这一次)。
        coverage: {
          sources: ["claude", "codex", "kimi", "opencode"],
          note:
            "cursor / cherry-studio 未入库；minimax 是 API 用量账单，没有会话概念。" +
            "「新开」按首条消息日算，与 Token 趋势 tooltip 里按最后更新日落桶的会话数口径不同。",
        },
      });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/api/ai-sessions/day/:day", (c) => {
    const day = c.req.param("day");
    if (!DAY_RE.test(day)) {
      return jsonErr(400, `invalid day: expected YYYY-MM-DD, got ${JSON.stringify(day)}`);
    }
    try {
      return c.json({ day, sessions: daySessionDetail(db, day) });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });
}
