/**
 * hermes → agent_user_messages 摄取(v1)。
 *
 * **全量重扫,不用水位。** 真库只有 1537 条消息 / 120 场会话,一轮全扫是毫秒级;
 * 而水位是这个仓库里翻过车的地方(opencode 的「筛选时钟 ≠ 推进时钟」永久丢过
 * 550/1934 条)。在这个体量上,水位是纯粹的风险没有收益。`watermarkMs` 仍然写
 * (记录本轮扫到的最大时间戳),但**不参与过滤** —— 只作可观测性。
 *
 * 口径:三层回落 + tool 结果折进宿主 assistant 的 payload,见 hermesHistory/normalize.ts。
 */
import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import {
  CLEANER_VERSION,
  PARSER_VERSION,
  assistantText,
  attachToolResults,
  isoFromEpochSeconds,
  parseToolCalls,
} from "../hermesHistory/normalize.js";
import { hermesDbPath, resolveHermesHome } from "../hermesHistory/paths.js";
import {
  assertSchema,
  listAllMessagesForIngest,
  openHermesDb,
  type MessageRow,
} from "../hermesHistory/stateDb.js";
import { getSyncState, setSyncState, upsertUserMessagesBatch } from "./store.js";
import type { UpsertUserMessageInput } from "./types.js";

/**
 * ingest 口径的版本号。改动「收哪些行 / cleaned_text 取哪一层 / payload 存什么」时 +1,
 * 已入库的装机会在下一轮自动全量重扫。
 *
 * 1 = 首版。收 user + assistant;assistant 的 cleaned_text 走三层回落
 *     (content → reasoning_content → 工具调用摘要);tool 结果折进宿主的 payload;
 *     session_meta 丢弃。
 */
export const HERMES_INGEST_VERSION = 1;

/** 每 N 条消息一事务。1537 条量级下只会有一两批,留着是为了以后长大不用改结构。 */
const BATCH_ROWS = 500;

export type HermesIngestResult = {
  status: "success" | "partial" | "skipped" | "failed";
  scannedSessions: number;
  upserted: number;
  watermarkMs: number;
  error?: string;
};

/** 把一个会话的原始行折成待写入的 aum 行。tool / session_meta 不产生行。 */
export function buildRowsForSession(
  sessionId: string,
  rows: readonly MessageRow[],
  sourcePath: string
): UpsertUserMessageInput[] {
  const resultsByCallId = new Map<string, string>();
  for (const r of rows) {
    if (r.role === "tool" && r.tool_call_id) {
      resultsByCallId.set(r.tool_call_id, r.content ?? "");
    }
  }

  const out: UpsertUserMessageInput[] = [];
  let lastUserKey: string | null = null;

  for (const r of rows) {
    if (r.role === "user") {
      const text = (r.content ?? "").trim();
      const key = String(r.id);
      lastUserKey = key;
      out.push({
        source: "hermes",
        sourceSessionId: sessionId,
        sourceMessageKey: key,
        // hermes 没有项目归属:真库 cwd 9/120、git_repo_root 0/120。
        // 恒为 null 是有意的 —— 不发明伪 project_key 去污染按项目组织的聚合页。
        project: null,
        eventAtUtc: isoFromEpochSeconds(r.timestamp),
        rawText: r.content ?? "",
        rawPayloadJson: JSON.stringify({ id: r.id, role: "user", content: r.content }),
        cleanedText: text,
        isHuman: true,
        cleanerVersion: CLEANER_VERSION,
        parserVersion: PARSER_VERSION,
        sourcePath,
        role: "user",
      });
    } else if (r.role === "assistant") {
      const calls = parseToolCalls(r.tool_calls);
      const { text } = assistantText(r.content, r.reasoning_content, calls);
      out.push({
        source: "hermes",
        sourceSessionId: sessionId,
        sourceMessageKey: String(r.id),
        project: null,
        eventAtUtc: isoFromEpochSeconds(r.timestamp),
        rawText: r.content ?? "",
        // tool 结果全文只在 payload 里 —— 进 cleaned_text 就是把工具输出伪装成
        // 「AI 说的话」,污染搜索页的 role='assistant' 筛子。
        rawPayloadJson: JSON.stringify({
          id: r.id,
          role: "assistant",
          content: r.content,
          reasoningContent: r.reasoning_content,
          toolCalls: attachToolResults(calls, resultsByCallId),
        }),
        cleanedText: text,
        isHuman: false,
        cleanerVersion: CLEANER_VERSION,
        parserVersion: PARSER_VERSION,
        sourcePath,
        role: "assistant",
        answeringUserKey: lastUserKey,
      });
    }
  }
  return out;
}

export function ingestHermesUserMessages(
  db: Database.Database,
  opts: { hermesHome?: string } = {}
): HermesIngestResult {
  const nowIso = new Date().toISOString();
  const home = resolveHermesHome(opts.hermesHome);
  const dbPath = hermesDbPath(home);

  if (!existsSync(dbPath)) {
    setSyncState(db, "hermes", {
      watermarkMs: getSyncState(db, "hermes")?.watermarkMs ?? 0,
      lastRunAt: nowIso,
      lastStatus: "skipped",
      lastError: null,
      ingestVersion: getSyncState(db, "hermes")?.ingestVersion ?? 0,
    });
    return { status: "skipped", scannedSessions: 0, upserted: 0, watermarkMs: 0 };
  }

  const prior = getSyncState(db, "hermes");
  let watermark = prior?.watermarkMs ?? 0;
  let scanned = 0;
  let upserted = 0;
  let src: Database.Database;

  try {
    src = openHermesDb(dbPath);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    setSyncState(db, "hermes", {
      watermarkMs: watermark,
      lastRunAt: nowIso,
      lastStatus: "failed",
      lastError: error,
      ingestVersion: prior?.ingestVersion ?? 0,
    });
    return { status: "failed", scannedSessions: 0, upserted: 0, watermarkMs: watermark, error };
  }

  try {
    assertSchema(src, dbPath);
    const bySession = listAllMessagesForIngest(src);
    let pending: UpsertUserMessageInput[] = [];
    let maxTs = watermark;

    const flush = () => {
      if (pending.length === 0) return;
      upserted += upsertUserMessagesBatch(db, pending, nowIso);
      pending = [];
    };

    for (const [sessionId, rows] of bySession) {
      scanned++;
      for (const r of rows) {
        const ms = typeof r.timestamp === "number" ? Math.round(r.timestamp * 1000) : 0;
        if (ms > maxTs) maxTs = ms;
      }
      pending.push(...buildRowsForSession(sessionId, rows, dbPath));
      if (pending.length >= BATCH_ROWS) flush();
    }
    flush();
    watermark = maxTs;

    setSyncState(db, "hermes", {
      watermarkMs: watermark,
      lastRunAt: nowIso,
      lastStatus: "success",
      lastError: null,
      ingestVersion: HERMES_INGEST_VERSION,
    });
    return { status: "success", scannedSessions: scanned, upserted, watermarkMs: watermark };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    setSyncState(db, "hermes", {
      watermarkMs: watermark,
      lastRunAt: nowIso,
      lastStatus: "failed",
      lastError: error,
      ingestVersion: prior?.ingestVersion ?? 0,
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
