/**
 * agent_user_messages 读侧:全文搜索(trigram + <3 码点 LIKE 兜底,D4)、原文审计、
 * cleaner_version 回填(D10)。
 */
import type Database from "better-sqlite3";
import {
  CLEANER_VERSION,
  recleanOpencodeFromPayload,
} from "../opencodeHistory/myMessages.js";
import {
  CLAUDE_CLEANER_VERSION,
  recleanClaudeFromPayload,
} from "../claudeCodeHistory/myMessages.js";
import {
  CODEX_CLEANER_VERSION,
  recleanCodexFromPayload,
} from "../codexHistory/myMessages.js";
import {
  anchorBucketStart,
  bucketExpr,
  iterateBuckets,
  previousWindowRange,
  windowToRange,
} from "../timeWindow/bucket.js";
import {
  windowToGranularity,
  type BucketGranularity,
  type WindowKey,
} from "../timeWindow/types.js";
import { syncFtsRow } from "./store.js";
import type {
  AgentUserMessageRaw,
  AgentUserMessageSearchHit,
  AgentUserMessageSource,
} from "./types.js";

/**
 * 搜谁的话。**不传 = 只搜你的话**,与 V53 之前逐条一致 —— 这是硬约束:
 * /agent-messages 今天已经能用,加 AI 内容不能让它变难用。
 *
 * AI 消息是人类消息的 5.76 倍(实测 13414 : 2299),中位长度只有 87 字,大量是
 * 「好的,我来看看」。原方案是用 char_len 门槛压噪音,codex 指出那个维度选错了:
 * 长度不等于价值 —— 会杀掉「是的,watermark 那行错了」这种高价值短答案,
 * 却保留冗长套话。改成按 role 筛,让「搜 AI 的话」成为显式动作。
 */
export type SearchRoleFilter = "user" | "assistant" | "all";

export type SearchOpts = {
  q: string;
  source?: AgentUserMessageSource;
  from?: string; // ISO 下界(含)
  to?: string; // ISO 上界(不含)
  limit?: number;
  /** 缺省 "user":只搜 is_human=1 的行,与 V53 之前完全一致。 */
  role?: SearchRoleFilter;
};

/**
 * role 过滤的 SQL 片段。
 *
 * "user" 用 `is_human = 1` 而不是 `role = 'user'` —— 两者**不等价**:这张表里
 * 还留着 4.9 万条 role='user' 但 is_human=0 的注入噪音行(留底,从不删)。
 * 搜索从来只看 is_human=1,改用 role='user' 会把那堆噪音放进结果里。
 */
function roleFilterSql(role: SearchRoleFilter | undefined): string {
  switch (role) {
    case "assistant":
      return "m.role = 'assistant'";
    case "all":
      return "(m.is_human = 1 OR m.role = 'assistant')";
    case "user":
    default:
      return "m.is_human = 1";
  }
}

/** fts5 phrase 查询:整串当一个短语,内部双引号翻倍转义。 */
function ftsPhrase(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

/** LIKE 通配转义(\ % _),配合 ESCAPE '\'。 */
function likeEscape(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** LIKE 路径的手工片段:命中位置 ±40 字窗口,命中处 [ ] 包裹。 */
function makeSnippet(text: string, q: string): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, 120);
  const chars = [...text];
  // 用码点定位,避免多字节切半。
  const pre = [...text.slice(0, idx)].length;
  const qlen = [...q].length;
  const start = Math.max(0, pre - 40);
  const end = Math.min(chars.length, pre + qlen + 40);
  const head = start > 0 ? "…" : "";
  const tail = end < chars.length ? "…" : "";
  const before = chars.slice(start, pre).join("");
  const hit = chars.slice(pre, pre + qlen).join("");
  const after = chars.slice(pre + qlen, end).join("");
  return `${head}${before}[${hit}]${after}${tail}`;
}

export function searchUserMessages(
  db: Database.Database,
  opts: SearchOpts
): AgentUserMessageSearchHit[] {
  const q = (opts.q ?? "").trim();
  if (!q) return [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const filters: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.source) {
    filters.push("m.source = @source");
    params.source = opts.source;
  }
  if (opts.from) {
    filters.push("m.event_at_utc >= @from");
    params.from = opts.from;
  }
  if (opts.to) {
    filters.push("m.event_at_utc < @to");
    params.to = opts.to;
  }
  const filterSql = filters.length ? ` AND ${filters.join(" AND ")}` : "";
  const roleSql = roleFilterSql(opts.role);
  params.limit = limit;

  // D4:<3 码点(2 字中文词 trigram 命中不了)→ LIKE 全表兜底。
  if ([...q].length < 3) {
    params.like = `%${likeEscape(q)}%`;
    const rows = db
      .prepare(
        `SELECT m.id AS id, m.source AS source,
                m.source_session_id AS sourceSessionId,
                m.event_at_utc AS eventAtUtc, m.cleaned_text AS cleanedText,
                m.role AS role,
                (SELECT a.cleaned_text FROM agent_user_messages a
                  WHERE a.source = m.source
                    AND a.source_session_id = m.source_session_id
                    AND a.source_message_key = m.answering_user_key) AS answering
         FROM agent_user_messages m
         WHERE ${roleSql} AND m.cleaned_text LIKE @like ESCAPE '\\'${filterSql}
         ORDER BY m.event_at_utc DESC
         LIMIT @limit`
      )
      .all(params) as Array<{
      id: number;
      source: AgentUserMessageSource;
      sourceSessionId: string;
      eventAtUtc: string;
      cleanedText: string;
      role: "user" | "assistant";
      answering: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      sourceSessionId: r.sourceSessionId,
      eventAtUtc: r.eventAtUtc,
      snippet: makeSnippet(r.cleanedText, q),
      role: r.role,
      answering: r.answering,
    }));
  }

  // ≥3 码点 → trigram MATCH。
  params.q = ftsPhrase(q);
  const rows = db
    .prepare(
      `SELECT m.id AS id, m.source AS source,
              m.source_session_id AS sourceSessionId,
              m.event_at_utc AS eventAtUtc,
              snippet(agent_user_messages_fts, 0, '[', ']', '…', 12) AS snippet,
              m.role AS role,
              (SELECT a.cleaned_text FROM agent_user_messages a
                WHERE a.source = m.source
                  AND a.source_session_id = m.source_session_id
                  AND a.source_message_key = m.answering_user_key) AS answering
       FROM agent_user_messages_fts
       JOIN agent_user_messages m ON m.id = agent_user_messages_fts.rowid
       WHERE agent_user_messages_fts MATCH @q AND ${roleSql}${filterSql}
       ORDER BY rank
       LIMIT @limit`
    )
    .all(params) as AgentUserMessageSearchHit[];
  return rows;
}

export type UserMessageAnalytics = {
  /** 跨源总量(仅 is_human 计):每源 消息数 + 累计字数。 */
  totals: { source: AgentUserMessageSource; count: number; charSum: number }[];
  /** 每天输入量(本地日,is_human=1)。D8:查询时按本地时区分桶,不物化 local_day。 */
  byDay: { day: string; count: number }[];
};

/**
 * 输入分析(v1.1)。同一张 agent_user_messages 表聚合,只算 is_human=1:
 *   - totals:跨 agent 消息量/字数对比
 *   - byDay:每天输入量(本地日,strftime localtime,与全 app 一致)
 */
export function userMessageAnalytics(
  db: Database.Database,
  opts?: { source?: AgentUserMessageSource; from?: string; to?: string }
): UserMessageAnalytics {
  const where: string[] = ["is_human = 1"];
  const params: Record<string, unknown> = {};
  if (opts?.source) {
    where.push("source = @source");
    params.source = opts.source;
  }
  if (opts?.from) {
    where.push("event_at_utc >= @from");
    params.from = opts.from;
  }
  if (opts?.to) {
    where.push("event_at_utc < @to");
    params.to = opts.to;
  }
  const whereSql = where.join(" AND ");

  const totals = db
    .prepare(
      `SELECT source, COUNT(*) AS count, COALESCE(SUM(char_len), 0) AS charSum
       FROM agent_user_messages WHERE ${whereSql}
       GROUP BY source ORDER BY count DESC`
    )
    .all(params) as UserMessageAnalytics["totals"];

  const byDay = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', event_at_utc, 'localtime') AS day, COUNT(*) AS count
       FROM agent_user_messages WHERE ${whereSql}
       GROUP BY day ORDER BY day`
    )
    .all(params) as UserMessageAnalytics["byDay"];

  return { totals, byDay };
}

export type UserMessageTimelineBucket = {
  bucketStart: string; // ISO 下界(含)
  bucketEnd: string; // ISO 上界(不含)
  claude: number;
  codex: number;
  opencode: number;
  total: number;
};

/** 时间线窗口:标准滚动窗口,或「今天」(今天 0 点→现在、小时粒度,裁掉最早消息前的空整点)。 */
export type TimelineWindow = WindowKey | "today";

export type UserMessageTimeline = {
  window: TimelineWindow;
  granularity: BucketGranularity;
  range: { from: string; to: string };
  buckets: UserMessageTimelineBucket[];
  windowTotal: number;
  /** 上一等长窗口的 is_human 总数(环比,D6)。 */
  previousWindowTotal: number;
  /** (window - prev)/prev;prev===0 时 null。 */
  deltaRatio: number | null;
  /** 末桶 in-progress(bucketEnd > to)→ 前端 tooltip 标「截至现在」(D4)。 */
  lastBucketPartial: boolean;
};

/**
 * 窗口 → 半开范围 `[from, to)`(本地锚定)。时间线图与浏览列表**同源**,保证
 * 两者「同一个窗口」范围一致。设计 codex#1:非 today 必须 anchorBucketStart(向下含
 * 完整首桶),裸 windowToRange.from 会回归 anchor 向下的零丢弃。
 *   today → [今天 00:00 本地, now)
 *   else  → [anchorBucketStart(now-Ndays, granularity), now)
 */
export function resolveWindowRange(
  window: TimelineWindow,
  now: Date
): { from: Date; to: Date } {
  const to = new Date(now);
  if (window === "today") {
    return { from: anchorBucketStart(now, "day"), to };
  }
  const granularity = windowToGranularity(window);
  return {
    from: anchorBucketStart(windowToRange(window, now).from, granularity),
    to,
  };
}

/**
 * 窗口化时间线(复用 src/timeWindow 的窗口核)。设计 D3/D4/D6:
 * - anchor 向下:from = anchorBucketStart(windowToRange.from) → 首桶完整、zero-fill 零丢弃。
 * - zero-fill:iterateBuckets 枚举全桶,按 key(=bucketExpr SQL 输出)合并三源 count。
 * - 环比:previousWindowRange(from,to) 内 is_human 计数(全程 effective 范围,一致等长)。
 * - 末桶 partial:最后一桶 end > to(in-progress)→ lastBucketPartial=true。
 */
export function userMessageTimeline(
  db: Database.Database,
  opts: { window: TimelineWindow; source?: AgentUserMessageSource; now?: Date }
): UserMessageTimeline {
  const now = opts.now ?? new Date();
  // 粒度独立算(分桶用);from/to 复用 resolveWindowRange(与浏览列表同源,anchor 向下 D3)。
  const granularity: BucketGranularity =
    opts.window === "today" ? "hour" : windowToGranularity(opts.window);
  const { from, to } = resolveWindowRange(opts.window, now);
  const buckets = iterateBuckets(from, to, granularity);

  const filters = ["is_human = 1", "event_at_utc >= @from", "event_at_utc < @to"];
  const params: Record<string, unknown> = {
    from: from.toISOString(),
    to: to.toISOString(),
  };
  if (opts.source) {
    filters.push("source = @source");
    params.source = opts.source;
  }
  const rows = db
    .prepare(
      `SELECT ${bucketExpr(granularity, "event_at_utc")} AS k, source, COUNT(*) AS n
       FROM agent_user_messages WHERE ${filters.join(" AND ")}
       GROUP BY k, source`
    )
    .all(params) as { k: string; source: string; n: number }[];

  const byKey = new Map<
    string,
    { claude: number; codex: number; opencode: number }
  >();
  for (const r of rows) {
    const e = byKey.get(r.k) ?? { claude: 0, codex: 0, opencode: 0 };
    if (r.source === "claude") e.claude += r.n;
    else if (r.source === "codex") e.codex += r.n;
    else if (r.source === "opencode") e.opencode += r.n;
    byKey.set(r.k, e);
  }

  let windowTotal = 0;
  const outBuckets: UserMessageTimelineBucket[] = buckets.map((b) => {
    const e = byKey.get(b.key) ?? { claude: 0, codex: 0, opencode: 0 };
    const total = e.claude + e.codex + e.opencode;
    windowTotal += total;
    return {
      bucketStart: b.start.toISOString(),
      bucketEnd: b.end.toISOString(),
      claude: e.claude,
      codex: e.codex,
      opencode: e.opencode,
      total,
    };
  });

  // 「今天」优化:裁掉最早消息之前的空整点(6 点才有消息就从 6 点起;整点桶天然对齐)。
  // 空桶已计入 windowTotal(=0),裁剪只影响显示,不改总数/环比/末桶。
  let displayBuckets = outBuckets;
  if (opts.window === "today") {
    const firstNonEmpty = outBuckets.findIndex((b) => b.total > 0);
    if (firstNonEmpty > 0) displayBuckets = outBuckets.slice(firstNonEmpty);
    else if (firstNonEmpty === -1 && outBuckets.length > 0)
      displayBuckets = outBuckets.slice(-1); // 今天还没消息 → 只留当前整点,避免空图
  }

  // 环比(D6):effective 范围的上一等长窗口。
  const prev = previousWindowRange(from, to);
  const prevFilters = ["is_human = 1", "event_at_utc >= @pf", "event_at_utc < @pt"];
  const prevParams: Record<string, unknown> = {
    pf: prev.from.toISOString(),
    pt: prev.to.toISOString(),
  };
  if (opts.source) {
    prevFilters.push("source = @source");
    prevParams.source = opts.source;
  }
  const previousWindowTotal = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_user_messages WHERE ${prevFilters.join(" AND ")}`
      )
      .get(prevParams) as { n: number }
  ).n;
  const deltaRatio =
    previousWindowTotal === 0
      ? null
      : (windowTotal - previousWindowTotal) / previousWindowTotal;

  const last = displayBuckets[displayBuckets.length - 1];
  const lastBucketPartial =
    last != null && new Date(last.bucketEnd).getTime() > to.getTime();

  return {
    window: opts.window,
    granularity,
    range: { from: from.toISOString(), to: to.toISOString() },
    buckets: displayBuckets,
    windowTotal,
    previousWindowTotal,
    deltaRatio,
    lastBucketPartial,
  };
}

export type UserMessageListItem = {
  id: number;
  source: AgentUserMessageSource;
  sourceSessionId: string;
  eventAtUtc: string;
  text: string;
};

export type UserMessageListPage = {
  items: UserMessageListItem[];
  /** 下一页复合游标 {eventAt,id};已到底为 null。 */
  nextBefore: { eventAt: string; id: number } | null;
};

/**
 * 窗口内浏览(全源、最新在前、keyset 分页)。设计 codex#1/#2/#4:
 * - 范围 = resolveWindowRange(与图同源,anchor 向下)。
 * - 全源:不带 source filter → idx_aum_human_event(is_human,event_at_utc,source)
 *   等值+范围+倒序最优,零新索引。
 * - keyset 复合游标 (event_at_utc, id):event_at_utc 非唯一(唯一键是
 *   source+session+message_key),单列游标会跳过同时间戳剩余行;故
 *   ORDER BY event_at_utc DESC, id DESC + (before, beforeId) 严格下界。
 * - text = cleaned_text(浏览不做搜索 snippet)。
 */
export function userMessageList(
  db: Database.Database,
  opts: {
    window: TimelineWindow;
    before?: string;
    beforeId?: number;
    limit?: number;
    now?: Date;
  }
): UserMessageListPage {
  const now = opts.now ?? new Date();
  const { from, to } = resolveWindowRange(opts.window, now);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const filters = ["is_human = 1", "event_at_utc >= @from", "event_at_utc < @to"];
  const params: Record<string, unknown> = {
    from: from.toISOString(),
    to: to.toISOString(),
    limit,
  };
  if (opts.before != null && opts.beforeId != null) {
    filters.push(
      "(event_at_utc < @before OR (event_at_utc = @before AND id < @beforeId))"
    );
    params.before = opts.before;
    params.beforeId = opts.beforeId;
  }

  const items = db
    .prepare(
      `SELECT id, source, source_session_id AS sourceSessionId,
              event_at_utc AS eventAtUtc, cleaned_text AS text
       FROM agent_user_messages
       WHERE ${filters.join(" AND ")}
       ORDER BY event_at_utc DESC, id DESC
       LIMIT @limit`
    )
    .all(params) as UserMessageListItem[];

  // 满页 → 可能还有下一页;不足 → 到底。
  const last = items[items.length - 1];
  const nextBefore =
    items.length === limit && last != null
      ? { eventAt: last.eventAtUtc, id: last.id }
      : null;
  return { items, nextBefore };
}

export function getUserMessageRaw(
  db: Database.Database,
  id: number
): AgentUserMessageRaw | null {
  const r = db
    .prepare(
      `SELECT id, source, source_session_id AS sourceSessionId,
              event_at_utc AS eventAtUtc, raw_text AS rawText,
              raw_payload_json AS rawPayloadJson, cleaned_text AS cleanedText,
              is_human AS isHuman, cleaner_version AS cleanerVersion
       FROM agent_user_messages WHERE id = ?`
    )
    .get(id) as
    | (Omit<AgentUserMessageRaw, "isHuman"> & { isHuman: number })
    | undefined;
  if (!r) return null;
  return { ...r, isHuman: r.isHuman === 1 };
}

/**
 * cleaner_version 回填(D10):opencode 里 cleaner_version 落后 CLEANER_VERSION 的行,
 * 从 raw_payload_json 重算 cleaned/is_human,UPDATE + 逐行同步 FTS。返回 {scanned, updated}。
 */
/**
 * 通用 cleaner_version 回填:某源里 cleaner_version < targetVersion 的行,用 recleanFn
 * 从 raw_payload_json 重算 cleaned/is_human,UPDATE + 逐行同步 FTS(D10)。返回 {scanned, updated}。
 */
export function recleanBySource(
  db: Database.Database,
  source: AgentUserMessageSource,
  recleanFn: (rawPayloadJson: string) => { cleanedText: string; isHuman: boolean },
  targetVersion: number,
  opts?: { now?: Date }
): { scanned: number; updated: number } {
  const now = (opts?.now ?? new Date()).toISOString();
  const rows = db
    .prepare(
      `SELECT id, source, event_at_utc AS eventAtUtc, raw_payload_json AS rawPayloadJson
       FROM agent_user_messages
       WHERE source = ? AND cleaner_version < ?`
    )
    .all(source, targetVersion) as Array<{
    id: number;
    source: string;
    eventAtUtc: string;
    rawPayloadJson: string;
  }>;

  const tx = db.transaction(() => {
    let updated = 0;
    const upd = db.prepare(
      `UPDATE agent_user_messages
       SET cleaned_text = @cleaned, is_human = @isHuman, char_len = @charLen,
           cleaner_version = @ver, updated_at = @now
       WHERE id = @id`
    );
    for (const r of rows) {
      const re = recleanFn(r.rawPayloadJson);
      upd.run({
        id: r.id,
        cleaned: re.cleanedText,
        isHuman: re.isHuman ? 1 : 0,
        charLen: [...re.cleanedText].length,
        ver: targetVersion,
        now,
      });
      syncFtsRow(db, r.id, re.cleanedText, r.source, r.eventAtUtc);
      updated++;
    }
    return updated;
  });

  return { scanned: rows.length, updated: tx() };
}

export function recleanOpencode(db: Database.Database, opts?: { now?: Date }) {
  return recleanBySource(db, "opencode", recleanOpencodeFromPayload, CLEANER_VERSION, opts);
}

export function recleanClaude(db: Database.Database, opts?: { now?: Date }) {
  return recleanBySource(db, "claude", recleanClaudeFromPayload, CLAUDE_CLEANER_VERSION, opts);
}

export function recleanCodex(db: Database.Database, opts?: { now?: Date }) {
  return recleanBySource(db, "codex", recleanCodexFromPayload, CODEX_CLEANER_VERSION, opts);
}
