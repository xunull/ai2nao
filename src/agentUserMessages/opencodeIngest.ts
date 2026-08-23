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
  extractOpencodeAssistantMessage,
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
import {
  setOpencodeTokenUsageState,
  upsertOpencodeTokenEvents,
  type OpencodeTokenEvent,
} from "../opencodeTokenUsage/events.js";
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

/**
 * ingest 口径的版本号。改动「收哪些行 / 怎么算水位 / payload 存什么」时 +1,
 * 已入库的装机会在下一轮自动全量重扫。
 *
 * 1 = 修掉水位 bug 后的口径。此前消息级过滤器读一个在批循环里被改写的水位,
 *     导致「早创建、晚更新」的 session 的老消息被永久跳过(真库丢了 550/1934 条)。
 * 2 = 收 assistant 正文 + 逐消息 token 事件。此前 role 门只放 user 过。
 */
export const OPENCODE_INGEST_VERSION = 2;

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
  const storedVersion = state?.ingestVersion ?? 0;
  // 口径变了就本轮强制全量 —— 与五个 token refresh 的 rule_version 同一套家法
  // (claudeTokenUsage/refresh.ts:216-220)。光改代码不够:水位会挡住重扫。
  const versionStale = storedVersion !== OPENCODE_INGEST_VERSION;
  let watermark = versionStale ? 0 : (state?.watermarkMs ?? 0);

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
      // 库都没打开,什么都没做 —— 保留旧版本号,下轮仍会触发全量。
      ingestVersion: storedVersion,
    });
    return { status: "failed", scannedSessions: 0, upserted: 0, watermarkMs: watermark, error };
  }

  let scanned = 0;
  let upserted = 0;
  let sourceMessages = 0;
  let tokenEvents = 0;
  const startedAt = Date.now();
  try {
    const sessions = listAllSessionsForIngest(src, dbPath);
    // 只处理活跃 >= 水位的 session(未变的旧 session 不重读);升序以便水位单调推进。
    const todo = sessions.filter((s) => s.timeUpdatedMs >= watermark);

    for (let i = 0; i < todo.length; i += BATCH_SESSIONS) {
      const batch = todo.slice(i, i + BATCH_SESSIONS);
      const rows: UpsertUserMessageInput[] = [];
      const batchEvents: OpencodeTokenEvent[] = [];
      // 水位只跟 session 的 timeUpdated —— 与上面 todo 的筛子同一个时钟。
      let batchMaxMs = watermark;

      for (const s of batch) {
        scanned++;
        if (s.timeUpdatedMs > batchMaxMs) batchMaxMs = s.timeUpdatedMs;
        // 从 session directory 回填 project(slug,与 claude 对齐;供对话↔提交桥归属)。
        const project = slugFromPath(s.directory);
        const { messages, parts } = loadSessionMessagesAndParts(src, dbPath, s.id);
        const byMsg = groupRawPartsByMessage(parts);
        // answering_user_key:AI 那条回的是上一条 user。messages 已按时间升序,
        // 顺序扫一遍即可 —— 与 claude 侧同一做法。
        let lastUserKey: string | null = null;
        const events: OpencodeTokenEvent[] = [];
        for (const m of messages) {
          sourceMessages++;
          // 这里原先有一个 `if (m.timeCreated < watermark) continue`。删掉了:
          // session 筛子用的是 timeUpdated,消息过滤器却用 timeCreated,而 watermark
          // 在批循环内被改写 —— 两套时钟交叉,「早创建、晚更新」的 session 的老消息
          // 被永久跳过且不自愈。本文件 D9 头注早已论证过重处理在幂等 upsert 下免费,
          // 所以直接不过滤,只靠 session 级水位。
          const asst = extractOpencodeAssistantMessage(m, byMsg.get(m.id) ?? []);
          if (asst) {
            // token 事件:**全部** assistant 轮都要(真库 7430 条),
            // 哪怕这一轮没有可读正文 —— 量挂在消息上,不挂在正文上。
            if (asst.tokens) {
              events.push({
                sessionId: s.id,
                messageId: asst.messageId,
                eventAtIso: new Date(asst.eventAtMs).toISOString(),
                tokens: asst.tokens,
              });
            }
            // 正文侧只收有正文的(真库 2260 条)。空正文整行不写 ——
            // 与 claude 的「纯 thinking 行跳过而不是写空串」同一条规矩,
            // 否则空行会污染 FTS。
            if (asst.text.trim()) {
              rows.push({
                source: "opencode",
                sourceSessionId: s.id,
                sourceMessageKey: asst.messageId,
                project,
                eventAtUtc: new Date(asst.eventAtMs).toISOString(),
                rawText: asst.text,
                // 只存正文本身 —— assistant 的 tool part 实测 166.29 MB,
                // 全留底会往库里加 184 MB。照 claude 的做法。
                rawPayloadJson: JSON.stringify(asst.text),
                // AI 输出不经清洗:它不会往自己嘴里塞 system-reminder。
                cleanedText: asst.text,
                isHuman: false,
                role: "assistant",
                answeringUserKey: lastUserKey,
                cleanerVersion: CLEANER_VERSION,
                parserVersion: PARSER_VERSION,
                sourcePath: dbPath,
              });
            }
            continue;
          }
          const ex = extractOpencodeUserMessage(m, byMsg.get(m.id) ?? []);
          if (!ex) continue; // 非 user 轮
          lastUserKey = ex.messageId;
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
        }
        batchEvents.push(...events);
      }

      // 一批一事务:upsert + FTS 同步;成功后推水位(部分失败该批回滚、水位不进 → 下轮重扫)。
      upserted += upsertUserMessagesBatch(db, rows, nowIso);
      tokenEvents += upsertOpencodeTokenEvents(db, batchEvents);
      if (batchMaxMs > watermark) {
        watermark = batchMaxMs;
        setSyncState(db, "opencode", {
          watermarkMs: watermark,
          lastRunAt: nowIso,
          lastStatus: "success",
          lastError: null,
          // 逐批不推版本号 —— 中途崩掉时剩下的 session 还要靠它触发重扫。
          ingestVersion: storedVersion,
        });
      }
    }

    setSyncState(db, "opencode", {
      watermarkMs: watermark,
      lastRunAt: nowIso,
      lastStatus: "success",
      lastError: null,
      // 只有整轮跑完才推进版本号。
      ingestVersion: OPENCODE_INGEST_VERSION,
    });
    setOpencodeTokenUsageState(db, {
      sourceMessageCount: sourceMessages,
      indexedEventCount: tokenEvents,
      durationMs: Date.now() - startedAt,
      lastError: null,
      nowIso,
    });
    return { status: "success", scannedSessions: scanned, upserted, watermarkMs: watermark };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    setSyncState(db, "opencode", {
      watermarkMs: watermark,
      lastRunAt: nowIso,
      lastStatus: "failed",
      lastError: error,
      // 中途出错 = 这一轮不完整,保留旧版本号让下轮重来。
      ingestVersion: storedVersion,
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
