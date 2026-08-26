import type Database from "better-sqlite3";
import { bucketExpr } from "../timeWindow/bucket.js";

/**
 * 每天有多少 AI 会话。
 *
 * **口径：按有活动的天。** 一场会话在哪天有消息，就计入哪天。
 * 真库实测 42.3% 的 claude 会话跨天、最长跨 56 天，所以「按开始日」那种算法
 * 会让「整天在续旧会话」的日子显示成零 —— 实测 2026-08-26 按开始日就是 0。
 *
 * **两条线都建在 `agent_user_messages` 上**，因此天然同集合，
 * 差值就是纯粹的「续用旧会话」：
 *   - `active`  每个有消息的天各计一次
 *   - `started` 每场会话的**首条消息日**，只计一次
 *
 * 为什么不用 `work_session_duration.started_at` 当「新开」：那张表与 aum 的
 * 会话集合对不上，而且差异的两个方向都跟「新开 vs 在用」无关 ——
 * claude 有 96 场**有消息**的会话因源文件被 30 天滚动删除而带 `missing_since`
 * （过滤掉它们等于在图上挖一个「那几个月开得少」形状的假凹陷），
 * codex 另有 93 场有时长、非 missing、却在 aum 里零消息。
 *
 * 代价（页面要写明）：「新开日」是**首条消息日**，不是会话真正创建的时刻。
 * 对被滚动删除截断过的老会话，首条消息日会晚于真实创建日。
 *
 * 只覆盖入库的四个源。cursor / cherry-studio 没进 index.db；
 * minimax 是 API 用量账单，没有会话概念。
 */

const DAY = bucketExpr("day", "event_at_utc");

export type DailyPoint = {
  day: string;
  sessions: number;
  bySource: Record<string, number>;
};

export type DailySessions = {
  /** 每个有消息的天，各计一次。 */
  active: DailyPoint[];
  /** 每场会话的首条消息日。 */
  started: DailyPoint[];
};

export type DayRange = { from: string; to: string };

/** 把 (day, source, n) 行折成逐日点，`sessions` 是逐源之和。 */
function fold(rows: { day: string; source: string; n: number }[]): DailyPoint[] {
  const byDay = new Map<string, DailyPoint>();
  for (const r of rows) {
    let p = byDay.get(r.day);
    if (!p) {
      p = { day: r.day, sessions: 0, bySource: {} };
      byDay.set(r.day, p);
    }
    // 逐源已按 (source, session_id) 去重,所以直接相加即可 ——
    // COUNT(DISTINCT source||'/'||session_id) 表达式里已含 source,
    // 它**恒等于**逐源之和(不是巧合,是恒等式)。真正要防的是顶层写成
    // 不带 source 的 COUNT(DISTINCT session_id) —— 那会在 id 碰撞时少算。
    p.bySource[r.source] = (p.bySource[r.source] ?? 0) + r.n;
    p.sessions += r.n;
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * `from` 含、`to` 不含，都是本地日历日（`YYYY-MM-DD`）。
 * 用 `DAY` 表达式而不是对 `event_at_utc` 直接比较 —— 边界必须与分桶同口径，
 * 否则跨时区时首尾两天会错位。
 */
export function dailySessions(db: Database.Database, range: DayRange): DailySessions {
  const active = db
    .prepare(
      `SELECT ${DAY} AS day, source, COUNT(DISTINCT source_session_id) AS n
         FROM agent_user_messages
        WHERE ${DAY} >= @from AND ${DAY} < @to
        GROUP BY day, source`
    )
    .all(range) as { day: string; source: string; n: number }[];

  // 首条消息日在**全量**上算,再按窗口过滤 —— 不能先切窗口再取 MIN,
  // 否则窗口左边界之前就开始的会话会被误判成「在边界那天新开」。
  const started = db
    .prepare(
      `WITH firstDay AS (
         SELECT source, source_session_id, MIN(${DAY}) AS day
           FROM agent_user_messages
          GROUP BY source, source_session_id)
       SELECT day, source, COUNT(*) AS n
         FROM firstDay
        WHERE day >= @from AND day < @to
        GROUP BY day, source`
    )
    .all(range) as { day: string; source: string; n: number }[];

  return { active: fold(active), started: fold(started) };
}

export type DaySession = {
  source: string;
  sessionId: string;
  messages: number;
  /** 来自 `work_session_duration`；join 不上时为 null（源已删或尚未收录）。 */
  title: string | null;
  activeMs: number | null;
  projectPath: string | null;
};

/** aum 的源名 → `work_session_duration` 的源名。只有 claude 这一处不同。 */
const DURATION_SOURCE = "CASE m.source WHEN 'claude' THEN 'claude-code' ELSE m.source END";

/**
 * 某一天的会话列表。
 *
 * 主表是 aum（口径与图上的「在用」一致），duration 只用来取 title / 时长 / 项目。
 * **LEFT JOIN 不能改成 INNER** —— 真库里有会话在 aum 有消息却没有 duration 行
 * （两张表刷新节奏不同，新会话先进 aum）。丢掉它们会让列表与图上的数字对不上。
 */
export function daySessionDetail(db: Database.Database, day: string): DaySession[] {
  return db
    .prepare(
      `SELECT m.source                    AS source,
              m.source_session_id         AS sessionId,
              COUNT(*)                    AS messages,
              d.title                     AS title,
              d.active_ms                 AS activeMs,
              d.project_path              AS projectPath
         FROM agent_user_messages m
         LEFT JOIN work_session_duration d
                ON d.source = ${DURATION_SOURCE}
               AND d.session_id = m.source_session_id
        WHERE ${DAY.replace(/event_at_utc/g, "m.event_at_utc")} = @day
        GROUP BY m.source, m.source_session_id
        ORDER BY messages DESC, sessionId`
    )
    .all({ day }) as DaySession[];
}
