/**
 * agent_user_messages 写侧:幂等 upsert + 独立 fts5 手动同步 + sync_state。
 *
 * FTS 同步(D3/D10):独立 fts5 不是 external-content,`'rebuild'` 只重 tokenize 影子副本、
 * 捡不到更新后的 cleaned_text。故每次 upsert 后**逐行** DELETE+INSERT fts(rowid=主表 id)。
 * 主表删除由 applyV42 的 AFTER DELETE 触发器兜底清 fts。
 */
import type Database from "better-sqlite3";
import type {
  AgentUserMessageSyncState,
  UpsertUserMessageInput,
} from "./types.js";

/** upsert 一行 + 同事务 FTS 同步。返回主表 id。调用方负责包外层事务(分批)。 */
function upsertOne(
  db: Database.Database,
  input: UpsertUserMessageInput,
  nowIso: string
): number {
  db.prepare(
    `INSERT INTO agent_user_messages
       (source, source_session_id, source_message_key, project, event_at_utc,
        raw_text, raw_payload_json, cleaned_text, is_human, char_len,
        cleaner_version, parser_version, source_path, source_seen_at,
        ingested_at, updated_at)
     VALUES
       (@source, @sourceSessionId, @sourceMessageKey, @project, @eventAtUtc,
        @rawText, @rawPayloadJson, @cleanedText, @isHuman, @charLen,
        @cleanerVersion, @parserVersion, @sourcePath, @now, @now, @now)
     ON CONFLICT(source, source_session_id, source_message_key) DO UPDATE SET
        project = excluded.project,
        event_at_utc = excluded.event_at_utc,
        raw_text = excluded.raw_text,
        raw_payload_json = excluded.raw_payload_json,
        cleaned_text = excluded.cleaned_text,
        is_human = excluded.is_human,
        char_len = excluded.char_len,
        cleaner_version = excluded.cleaner_version,
        parser_version = excluded.parser_version,
        source_path = excluded.source_path,
        source_seen_at = excluded.source_seen_at,
        updated_at = excluded.updated_at`
  ).run({
    source: input.source,
    sourceSessionId: input.sourceSessionId,
    sourceMessageKey: input.sourceMessageKey,
    project: input.project,
    eventAtUtc: input.eventAtUtc,
    rawText: input.rawText,
    rawPayloadJson: input.rawPayloadJson,
    cleanedText: input.cleanedText,
    isHuman: input.isHuman ? 1 : 0,
    charLen: [...input.cleanedText].length,
    cleanerVersion: input.cleanerVersion,
    parserVersion: input.parserVersion,
    sourcePath: input.sourcePath,
    now: nowIso,
  });

  const id = (
    db
      .prepare(
        `SELECT id FROM agent_user_messages
         WHERE source = ? AND source_session_id = ? AND source_message_key = ?`
      )
      .get(input.source, input.sourceSessionId, input.sourceMessageKey) as {
      id: number;
    }
  ).id;

  syncFtsRow(db, id, input.cleanedText, input.source, input.eventAtUtc);
  return id;
}

/** 逐行同步一条 FTS(D10:DELETE+INSERT,不用 rebuild)。 */
export function syncFtsRow(
  db: Database.Database,
  id: number,
  cleanedText: string,
  source: string,
  eventAtUtc: string
): void {
  db.prepare("DELETE FROM agent_user_messages_fts WHERE rowid = ?").run(id);
  db.prepare(
    `INSERT INTO agent_user_messages_fts(rowid, cleaned_text, source, event_at_utc)
     VALUES (?, ?, ?, ?)`
  ).run(id, cleanedText, source, eventAtUtc);
}

/** 分批 upsert(一批一事务:全成或全滚,配合 ingest 逐批推水位)。返回写入行数。 */
export function upsertUserMessagesBatch(
  db: Database.Database,
  rows: UpsertUserMessageInput[],
  nowIso: string
): number {
  if (rows.length === 0) return 0;
  const tx = db.transaction((batch: UpsertUserMessageInput[]) => {
    for (const r of batch) upsertOne(db, r, nowIso);
    return batch.length;
  });
  return tx(rows);
}

export function getSyncState(
  db: Database.Database,
  source: string
): AgentUserMessageSyncState | null {
  const r = db
    .prepare(
      `SELECT watermark_ms AS watermarkMs, last_run_at AS lastRunAt,
              last_status AS lastStatus, last_error AS lastError
       FROM agent_user_messages_sync_state WHERE source = ?`
    )
    .get(source) as
    | {
        watermarkMs: number | null;
        lastRunAt: string | null;
        lastStatus: string | null;
        lastError: string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    watermarkMs: r.watermarkMs ?? 0,
    lastRunAt: r.lastRunAt,
    lastStatus: r.lastStatus,
    lastError: r.lastError,
  };
}

export function setSyncState(
  db: Database.Database,
  source: string,
  state: AgentUserMessageSyncState
): void {
  db.prepare(
    `INSERT INTO agent_user_messages_sync_state
       (source, watermark_ms, last_run_at, last_status, last_error)
     VALUES (@source, @watermarkMs, @lastRunAt, @lastStatus, @lastError)
     ON CONFLICT(source) DO UPDATE SET
        watermark_ms = excluded.watermark_ms,
        last_run_at = excluded.last_run_at,
        last_status = excluded.last_status,
        last_error = excluded.last_error`
  ).run({
    source,
    watermarkMs: state.watermarkMs,
    lastRunAt: state.lastRunAt,
    lastStatus: state.lastStatus,
    lastError: state.lastError,
  });
}
