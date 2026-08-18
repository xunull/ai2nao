/**
 * kimi → agent_user_messages 摄取。
 *
 * 增量:按 wire.jsonl 文件 mtime 水位 `>=` 过滤,分批 upsert + 逐批推水位 —— 与
 * claude/codex 同一套模型(rule of three 已到,抽公共 helper 见 TODOS)。**水位钳制
 * 从第一天就带上**:codexIngest 至今还缺它(7de68d1 只修了 claude),那个缺陷会让
 * 任何解析失败的文件被永久排除且 lastStatus 照写 success。
 *
 * 两个根共用一个解析器(CLI 的 ~/.kimi-code 与桌面版内嵌的 kimi-code 沙箱格式相同),
 * 见 kimiHistory/paths.ts。自然 key:source_session_id = kimi 自己的会话目录名
 * (`session_<uuid>` 或 `conv-<id>`,**不含路径**,所以同一会话即使被复制到另一个根
 * 也只入一次);source_message_key = 人用 message.id 或 `<agent>:t<time>:<hash>`,
 * AI 用 content.part 事件的 uuid。
 *
 * 口径:共享 extractKimiMessages —— 以后做 kimi 会话详情页也走它,不要再写第二份判据。
 */
import type Database from "better-sqlite3";
import {
  KIMI_CLEANER_VERSION,
  KIMI_PARSER_VERSION,
  extractKimiMessages,
} from "../kimiHistory/myMessages.js";
import { scanKimiWireFiles } from "../kimiHistory/scan.js";
import { slugFromPath } from "./projectKey.js";
import { getSyncState, setSyncState, upsertUserMessagesBatch } from "./store.js";
import type { UpsertUserMessageInput } from "./types.js";

const BATCH_FILES = 40;

export type KimiIngestResult = {
  status: "success" | "partial" | "skipped" | "failed";
  scannedFiles: number;
  upserted: number;
  watermarkMs: number;
  error?: string;
};

export function ingestKimiUserMessages(
  db: Database.Database,
  opts?: { cliRoot?: string; desktopRoot?: string; now?: Date }
): KimiIngestResult {
  const nowIso = (opts?.now ?? new Date()).toISOString();
  const state = getSyncState(db, "kimi");
  let watermark = state?.watermarkMs ?? 0;

  // 水位钳制,两处跳过性质不同(与 claudeIngest 同注释):
  //  1. 单文件解析失败 → 知道 mtime,把水位钳在最早那个失败文件之前
  //  2. 目录列举失败   → 文件根本没进 files,没有 mtime 可钳 → 整轮不推水位
  let runFirstFailureMtime: number | null = null;
  const noteFileFailure = (mtimeMs: number) => {
    if (runFirstFailureMtime === null || mtimeMs < runFirstFailureMtime) {
      runFirstFailureMtime = mtimeMs;
    }
  };

  let files;
  let dirListFailure = false;
  try {
    const r = scanKimiWireFiles({
      cliRoot: opts?.cliRoot,
      desktopRoot: opts?.desktopRoot,
    });
    files = r.files;
    dirListFailure = r.dirListFailure;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    setSyncState(db, "kimi", {
      watermarkMs: watermark,
      lastRunAt: nowIso,
      lastStatus: "failed",
      lastError: error,
    });
    return { status: "failed", scannedFiles: 0, upserted: 0, watermarkMs: watermark, error };
  }

  // 两个根都不存在 = 这台机器没装 kimi。干净跳过,不写水位,不报错。
  if (files.length === 0 && !dirListFailure) {
    return { status: "skipped", scannedFiles: 0, upserted: 0, watermarkMs: watermark };
  }

  const todo = files
    .filter((f) => f.mtimeMs >= watermark)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  let scanned = 0;
  let upserted = 0;
  let multiPartTurns = 0;

  try {
    for (let i = 0; i < todo.length; i += BATCH_FILES) {
      const batch = todo.slice(i, i + BATCH_FILES);
      const rows: UpsertUserMessageInput[] = [];
      let batchMaxMs = watermark;

      for (const f of batch) {
        scanned++;
        let ex;
        try {
          ex = extractKimiMessages(f);
        } catch {
          // 跳过但**钳住水位** —— 不钳的话这个文件下轮就被 >= 过滤永久排除。
          noteFileFailure(f.mtimeMs);
          continue;
        }
        multiPartTurns += ex.multiPartTurns;
        const project = slugFromPath(ex.projectPath);
        for (const m of ex.messages) {
          rows.push({
            source: "kimi",
            sourceSessionId: ex.sessionId,
            sourceMessageKey: m.messageKey,
            project,
            eventAtUtc: new Date(m.eventAtMs).toISOString(),
            rawText: m.rawText,
            rawPayloadJson: m.rawPayloadJson,
            cleanedText: m.cleanedText,
            isHuman: m.isHuman,
            cleanerVersion: KIMI_CLEANER_VERSION,
            parserVersion: KIMI_PARSER_VERSION,
            sourcePath: f.filePath,
            role: m.role,
            answeringUserKey: m.answeringUserKey,
          });
        }
        if (f.mtimeMs > batchMaxMs) batchMaxMs = f.mtimeMs;
      }

      upserted += upsertUserMessagesBatch(db, rows, nowIso);

      if (dirListFailure) continue; // 整轮不推水位
      const capped =
        runFirstFailureMtime === null
          ? batchMaxMs
          : Math.min(batchMaxMs, runFirstFailureMtime - 1);
      if (capped > watermark) {
        watermark = capped;
        setSyncState(db, "kimi", {
          watermarkMs: watermark,
          lastRunAt: nowIso,
          lastStatus: "success",
          lastError: null,
        });
      }
    }

    // 有跳过 / 有多-part 轮就不能报 success。多-part 那条是 T8 的不变量:
    // 实测 1225 个 text part 里 0 条需要拼接,但重试或超长输出可能改变它 ——
    // 真发生了要在 sync_state 里看得见,而不是静默产生碎片行。
    const notes: string[] = [];
    if (dirListFailure) notes.push("目录列举失败,本轮不推水位");
    if (runFirstFailureMtime !== null) {
      notes.push(`有文件解析失败,水位钳在 mtime ${runFirstFailureMtime} 之前,下轮重试`);
    }
    if (multiPartTurns > 0) {
      notes.push(
        `${multiPartTurns} 轮出现多个 text part —— 「一个 part = 一条消息」的前提已不成立,需要改成聚合`
      );
    }
    const degraded = notes.length > 0;
    setSyncState(db, "kimi", {
      watermarkMs: watermark,
      lastRunAt: nowIso,
      lastStatus: degraded ? "partial" : "success",
      lastError: degraded ? notes.join(" | ") : null,
    });
    return {
      status: degraded ? "partial" : "success",
      scannedFiles: scanned,
      upserted,
      watermarkMs: watermark,
      ...(degraded ? { error: notes.join(" | ") } : {}),
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    setSyncState(db, "kimi", {
      watermarkMs: watermark,
      lastRunAt: nowIso,
      lastStatus: "failed",
      lastError: error,
    });
    return {
      status: upserted > 0 ? "partial" : "failed",
      scannedFiles: scanned,
      upserted,
      watermarkMs: watermark,
      error,
    };
  }
}
