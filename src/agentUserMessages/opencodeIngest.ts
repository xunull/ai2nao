/**
 * opencode → agent_user_messages 摄取(v1)。
 *
 * 增量(D9):按 message.time_created **列** 的水位 `>=` 过滤(幂等 upsert 下重处理并列免费,
 * 避免边界丢);**分批**(每 BATCH_SESSIONS 个 session 一事务)commit + 逐批推水位,绝不把
 * 3.2GB 首轮塞进单事务锁库。孤儿留底 = 从不删(D7:不做 missing_since 删除检测)。
 * 口径:共享 extractOpencodeUserMessage(含 role 门,与抽屉同源)。
 */
import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import {
  CLEANER_VERSION,
  PARSER_VERSION,
  extractOpencodeUserMessage,
  groupRawPartsByMessage,
} from "../opencodeHistory/myMessages.js";
import { opencodeDbPath, resolveOpencodeDataDir } from "../opencodeHistory/paths.js";
import {
  listAllSessionsForIngest,
  loadSessionMessagesAndParts,
  openOpencodeDb,
} from "../opencodeHistory/stateDb.js";
import { slugFromPath } from "./projectKey.js";
import { getSyncState, setSyncState, upsertUserMessagesBatch } from "./store.js";
import type { UpsertUserMessageInput } from "./types.js";

/** 每 N 个 session 一事务(D9:分批,不锁大事务)。 */
const BATCH_SESSIONS = 50;

export type OpencodeIngestResult = {
  status: "success" | "partial" | "skipped" | "failed";
  scannedSessions: number;
  upserted: number;
  watermarkMs: number;
  error?: string;
};

export function ingestOpencodeUserMessages(
  db: Database.Database, // index.db(写)
  opts?: { dataDir?: string; now?: Date }
): OpencodeIngestResult {
  const now = opts?.now ?? new Date();
  const nowIso = now.toISOString();
  const dataDir = resolveOpencodeDataDir(opts?.dataDir);
  const dbPath = opencodeDbPath(dataDir);

  if (!existsSync(dbPath)) {
    return { status: "skipped", scannedSessions: 0, upserted: 0, watermarkMs: 0 };
  }

  const state = getSyncState(db, "opencode");
  let watermark = state?.watermarkMs ?? 0;

  let src: Database.Database;
  try {
    src = openOpencodeDb(dbPath);
  } catch (e) {
    // db 被锁 / schema 不兼容 → 干净失败,不崩、不清历史。
    const error = e instanceof Error ? e.message : String(e);
    setSyncState(db, "opencode", {
      watermarkMs: watermark,
      lastRunAt: nowIso,
      lastStatus: "failed",
      lastError: error,
    });
    return { status: "failed", scannedSessions: 0, upserted: 0, watermarkMs: watermark, error };
  }

  let scanned = 0;
  let upserted = 0;
  try {
    const sessions = listAllSessionsForIngest(src, dbPath);
    // 只处理活跃 >= 水位的 session(未变的旧 session 不重读);升序以便水位单调推进。
    const todo = sessions.filter((s) => s.timeUpdatedMs >= watermark);

    for (let i = 0; i < todo.length; i += BATCH_SESSIONS) {
      const batch = todo.slice(i, i + BATCH_SESSIONS);
      const rows: UpsertUserMessageInput[] = [];
      let batchMaxMs = watermark;

      for (const s of batch) {
        scanned++;
        // 从 session directory 回填 project(slug,与 claude 对齐;供对话↔提交桥归属)。
        const project = slugFromPath(s.directory);
        const { messages, parts } = loadSessionMessagesAndParts(src, dbPath, s.id);
        const byMsg = groupRawPartsByMessage(parts);
        for (const m of messages) {
          if (m.timeCreated < watermark) continue; // D9: >= watermark(跳过已入库)
          const ex = extractOpencodeUserMessage(m, byMsg.get(m.id) ?? []);
          if (!ex) continue; // 非 user 轮
          rows.push({
            source: "opencode",
            sourceSessionId: s.id,
            sourceMessageKey: ex.messageId,
            project,
            eventAtUtc: new Date(ex.eventAtMs).toISOString(),
            rawText: ex.rawText,
            rawPayloadJson: ex.rawPayloadJson,
            cleanedText: ex.cleanedText,
            isHuman: ex.isHuman,
            cleanerVersion: CLEANER_VERSION,
            parserVersion: PARSER_VERSION,
            sourcePath: dbPath,
          });
          if (m.timeCreated > batchMaxMs) batchMaxMs = m.timeCreated;
        }
      }

      // 一批一事务:upsert + FTS 同步;成功后推水位(部分失败该批回滚、水位不进 → 下轮重扫)。
      upserted += upsertUserMessagesBatch(db, rows, nowIso);
      if (batchMaxMs > watermark) {
        watermark = batchMaxMs;
        setSyncState(db, "opencode", {
          watermarkMs: watermark,
          lastRunAt: nowIso,
          lastStatus: "success",
          lastError: null,
        });
      }
    }

    setSyncState(db, "opencode", {
      watermarkMs: watermark,
      lastRunAt: nowIso,
      lastStatus: "success",
      lastError: null,
    });
    return { status: "success", scannedSessions: scanned, upserted, watermarkMs: watermark };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    setSyncState(db, "opencode", {
      watermarkMs: watermark,
      lastRunAt: nowIso,
      lastStatus: "failed",
      lastError: error,
    });
    return {
      status: upserted > 0 ? "partial" : "failed",
      scannedSessions: scanned,
      upserted,
      watermarkMs: watermark,
      error,
    };
  } finally {
    src.close();
  }
}
