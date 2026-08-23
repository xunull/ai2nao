import type Database from "better-sqlite3";
import type { OpencodeMessageTokens } from "../opencodeHistory/myMessages.js";

/**
 * opencode 的逐消息 token 事件(V57)。
 *
 * 为什么 opencode 有而别家没有:它的 `message.data.tokens` 原生带完整向量
 * `{input, output, reasoning, cache:{read,write}}`,是四个源里唯一**分离**的。
 * claude 的 `input_tokens` 是融合值,拆不开。
 *
 * 写入端只有 ingest 一处 —— token 与 assistant 正文躺在同一个 `message.data` 里,
 * 同一趟取走是零额外成本(`loadSessionMessagesAndParts` 本来就在一个事务里
 * 同时取 message 与 part)。
 */

/** 解析规则版本。改动分量映射口径时 +1。 */
export const OPENCODE_TOKEN_RULE_VERSION = 1;

export type OpencodeTokenEvent = {
  sessionId: string;
  messageId: string;
  eventAtIso: string;
  tokens: OpencodeMessageTokens;
};

export function upsertOpencodeTokenEvents(
  db: Database.Database,
  events: OpencodeTokenEvent[]
): number {
  if (events.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO opencode_token_usage_event
       (session_id, message_id, event_at, fresh_input, cache_read_input,
        cache_creation_input, output, reasoning_output)
     VALUES (@sessionId, @messageId, @eventAt, @freshInput, @cacheReadInput,
             @cacheCreationInput, @output, @reasoningOutput)
     ON CONFLICT(session_id, message_id) DO UPDATE SET
        event_at = excluded.event_at,
        fresh_input = excluded.fresh_input,
        cache_read_input = excluded.cache_read_input,
        cache_creation_input = excluded.cache_creation_input,
        output = excluded.output,
        reasoning_output = excluded.reasoning_output`
  );
  const run = db.transaction((rows: OpencodeTokenEvent[]) => {
    for (const e of rows) {
      stmt.run({
        sessionId: e.sessionId,
        messageId: e.messageId,
        eventAt: e.eventAtIso,
        freshInput: e.tokens.freshInput,
        cacheReadInput: e.tokens.cacheReadInput,
        cacheCreationInput: e.tokens.cacheCreationInput,
        output: e.tokens.output,
        reasoningOutput: e.tokens.reasoningOutput,
      });
    }
  });
  run(events);
  return events.length;
}

/**
 * state 表。趋势页 adapter 的 everPresent() 同时看 state 表与数据表 ——
 * 「有数据没 state 行」与「有 state 行没数据」是两种不同的真实状态,
 * 只看一个会把「索引损坏」误报成「你没用过 opencode」。
 */
export function setOpencodeTokenUsageState(
  db: Database.Database,
  o: {
    sourceMessageCount: number;
    indexedEventCount: number;
    durationMs: number;
    lastError: string | null;
    nowIso: string;
  }
): void {
  db.prepare(
    `INSERT INTO opencode_token_usage_state
       (id, rule_version, last_rebuilt_at, last_error, source_message_count,
        indexed_event_count, duration_ms, updated_at)
     VALUES (1, @ruleVersion, @now, @lastError, @sourceMessageCount,
             @indexedEventCount, @durationMs, @now)
     ON CONFLICT(id) DO UPDATE SET
        rule_version = excluded.rule_version,
        last_rebuilt_at = excluded.last_rebuilt_at,
        last_error = excluded.last_error,
        source_message_count = excluded.source_message_count,
        indexed_event_count = excluded.indexed_event_count,
        duration_ms = excluded.duration_ms,
        updated_at = excluded.updated_at`
  ).run({
    ruleVersion: OPENCODE_TOKEN_RULE_VERSION,
    now: o.nowIso,
    lastError: o.lastError,
    sourceMessageCount: o.sourceMessageCount,
    indexedEventCount: o.indexedEventCount,
    durationMs: o.durationMs,
  });
}
