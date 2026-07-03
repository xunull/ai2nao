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
import { syncFtsRow } from "./store.js";
import type {
  AgentUserMessageRaw,
  AgentUserMessageSearchHit,
  AgentUserMessageSource,
} from "./types.js";

export type SearchOpts = {
  q: string;
  source?: AgentUserMessageSource;
  from?: string; // ISO 下界(含)
  to?: string; // ISO 上界(不含)
  limit?: number;
};

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
  params.limit = limit;

  // D4:<3 码点(2 字中文词 trigram 命中不了)→ LIKE 全表兜底。
  if ([...q].length < 3) {
    params.like = `%${likeEscape(q)}%`;
    const rows = db
      .prepare(
        `SELECT m.id AS id, m.source AS source,
                m.source_session_id AS sourceSessionId,
                m.event_at_utc AS eventAtUtc, m.cleaned_text AS cleanedText
         FROM agent_user_messages m
         WHERE m.is_human = 1 AND m.cleaned_text LIKE @like ESCAPE '\\'${filterSql}
         ORDER BY m.event_at_utc DESC
         LIMIT @limit`
      )
      .all(params) as Array<{
      id: number;
      source: AgentUserMessageSource;
      sourceSessionId: string;
      eventAtUtc: string;
      cleanedText: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      sourceSessionId: r.sourceSessionId,
      eventAtUtc: r.eventAtUtc,
      snippet: makeSnippet(r.cleanedText, q),
    }));
  }

  // ≥3 码点 → trigram MATCH。
  params.q = ftsPhrase(q);
  const rows = db
    .prepare(
      `SELECT m.id AS id, m.source AS source,
              m.source_session_id AS sourceSessionId,
              m.event_at_utc AS eventAtUtc,
              snippet(agent_user_messages_fts, 0, '[', ']', '…', 12) AS snippet
       FROM agent_user_messages_fts
       JOIN agent_user_messages m ON m.id = agent_user_messages_fts.rowid
       WHERE agent_user_messages_fts MATCH @q AND m.is_human = 1${filterSql}
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
