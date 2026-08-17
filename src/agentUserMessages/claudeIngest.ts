/**
 * Claude Code → agent_user_messages 摄取(v2,V53 起连 AI 的话一起收)。
 *
 * 增量(D9):按会话 jsonl 文件 mtime 水位 `>=` 过滤(改过的文件重扫,幂等 upsert 按 uuid
 * 去重);**分批**(每 BATCH_FILES 个文件一事务)commit + 逐批推水位。孤儿留底 = 从不删。
 * 口径:共享 extractClaudeMessages(后端清洗,与抽屉端点同源 —— option C)。抽屉那侧调
 * 的是 extractClaudeUserMessages,它是同一函数 filter role==='user' 后的视图。
 * 自然 key:source_session_id = projectId:sessionId,source_message_key = record.uuid。
 *
 * V53 之前这里只收 role==='user'。放开的动机:Claude Code 按 30 天滚动窗口删本地
 * transcript,实测 170 个会话里已有 75 个源文件消失 —— 那些会话的提问因「孤儿留底」
 * 保住了 1988 条,AI 的回答则永久没了。每天还在以约 3 个会话的速度继续丢。
 */
import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { listSessionJsonlFiles } from "../claudeCodeHistory/discover.js";
import { readAndParseFile } from "../claudeCodeHistory/load.js";
import {
  CLAUDE_CLEANER_VERSION,
  CLAUDE_PARSER_VERSION,
  extractClaudeMessages,
} from "../claudeCodeHistory/myMessages.js";
import { resolveClaudeProjectsRoot } from "../claudeCodeHistory/paths.js";
import { getSyncState, setSyncState, upsertUserMessagesBatch } from "./store.js";
import type { UpsertUserMessageInput } from "./types.js";

/** 每 N 个文件一事务(D9:分批,不锁大事务)。 */
const BATCH_FILES = 40;

export type ClaudeIngestResult = {
  status: "success" | "partial" | "skipped" | "failed";
  scannedFiles: number;
  upserted: number;
  watermarkMs: number;
  error?: string;
};

export async function ingestClaudeUserMessages(
  db: Database.Database,
  opts?: { projectsRoot?: string; now?: Date }
): Promise<ClaudeIngestResult> {
  const now = opts?.now ?? new Date();
  const nowIso = now.toISOString();
  const root = resolveClaudeProjectsRoot(opts?.projectsRoot);

  if (!existsSync(root)) {
    return { status: "skipped", scannedFiles: 0, upserted: 0, watermarkMs: 0 };
  }

  const state = getSyncState(db, "claude");
  let watermark = state?.watermarkMs ?? 0;

  /**
   * 水位钳制(修两处静默永久丢失)。
   *
   * 水位是「已经处理干净的时间点」,所以任何**跳过**都必须把水位拦在它之前,
   * 否则下一轮的 `mtimeMs >= watermark` 会把它永久排除,而且一声不吭。
   *
   * 两处跳过的性质不同,钳制方式也不同:
   *
   * 1. **单文件解析失败**:知道它的 mtime → 把水位钳在 `该 mtime - 1`。
   *    取全 run 最小的失败 mtime,不能按批算 —— `batchMaxMs` 每批重置且每批
   *    commit 一次水位,批 N 钳住了,批 N+1 的文件 mtime 更大,照样推过去。
   * 2. **整个 project 目录列举失败**:它的文件根本没进 `files`,**没有 mtime 可钳**。
   *    run 级 mtime 钳制在结构上修不了这一处,只能整轮不推水位。
   *    这一处的粒度是「一个项目的全部历史」,后果比第 1 种重得多。
   *
   * 代价:一个**永久**失败的文件会把水位钉在 F-1,此后每轮都重扫 mtime >= F-1 的
   * 文件。当前实测不可达(readAndParseFile 只在 >200 MB 或 >50 万行时抛,真实最大
   * 70.6 MB / 14415 行),所以代价为零;真出现了,`lastError` 会写明是哪个文件,
   * 而不是像以前那样静默丢掉。
   */
  let runFirstFailureMtime: number | null = null;
  let dirListFailure: string | null = null;
  const noteFileFailure = (mtimeMs: number) => {
    if (runFirstFailureMtime === null || mtimeMs < runFirstFailureMtime) {
      runFirstFailureMtime = mtimeMs;
    }
  };

  // 枚举全部会话文件(projectId = 目录名;sessionId = 文件 stem)。
  const files: {
    projectId: string;
    sessionId: string;
    filePath: string;
    mtimeMs: number;
  }[] = [];
  try {
    const projectDirs = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const projectId of projectDirs) {
      try {
        const sf = await listSessionJsonlFiles(join(root, projectId));
        for (const f of sf) {
          files.push({
            projectId,
            sessionId: f.id,
            filePath: f.filePath,
            mtimeMs: f.mtimeMs,
          });
        }
      } catch (e) {
        // 单个 project 目录读失败 → 本轮不推水位(见上方注释第 2 条),
        // 但继续扫其它目录,已读到的仍然入库。
        dirListFailure = `${projectId}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    setSyncState(db, "claude", {
      watermarkMs: watermark,
      lastRunAt: nowIso,
      lastStatus: "failed",
      lastError: error,
    });
    return { status: "failed", scannedFiles: 0, upserted: 0, watermarkMs: watermark, error };
  }

  // 只处理 mtime >= 水位的文件;升序以便水位单调推进。
  const todo = files
    .filter((f) => f.mtimeMs >= watermark)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  let scanned = 0;
  let upserted = 0;
  try {
    for (let i = 0; i < todo.length; i += BATCH_FILES) {
      const batch = todo.slice(i, i + BATCH_FILES);
      const rows: UpsertUserMessageInput[] = [];
      let batchMaxMs = watermark;

      for (const f of batch) {
        scanned++;
        let built;
        try {
          built = await readAndParseFile(f.filePath, f.projectId, f.sessionId);
        } catch {
          // 单文件过大/坏 → 跳过,不拖垮整批;但记下 mtime,别让水位越过它。
          noteFileFailure(f.mtimeMs);
          continue;
        }
        for (const ex of extractClaudeMessages(built.session.messages)) {
          rows.push({
            source: "claude",
            sourceSessionId: `${f.projectId}:${f.sessionId}`,
            sourceMessageKey: ex.messageKey,
            project: f.projectId,
            eventAtUtc: new Date(ex.eventAtMs).toISOString(),
            rawText: ex.rawText,
            rawPayloadJson: ex.rawPayloadJson,
            cleanedText: ex.cleanedText,
            isHuman: ex.isHuman,
            cleanerVersion: CLAUDE_CLEANER_VERSION,
            parserVersion: CLAUDE_PARSER_VERSION,
            sourcePath: f.filePath,
            role: ex.role,
            answeringUserKey: ex.answeringUserKey,
          });
        }
        if (f.mtimeMs > batchMaxMs) batchMaxMs = f.mtimeMs;
      }

      upserted += upsertUserMessagesBatch(db, rows, nowIso);

      // 目录列举失败 → 整轮不推水位:那些文件没进 todo,没有 mtime 可钳。
      if (dirListFailure) continue;
      // 单文件失败 → 水位不得越过最早那个失败文件。
      const capped =
        runFirstFailureMtime === null
          ? batchMaxMs
          : Math.min(batchMaxMs, runFirstFailureMtime - 1);
      if (capped > watermark) {
        watermark = capped;
        setSyncState(db, "claude", {
          watermarkMs: watermark,
          lastRunAt: nowIso,
          lastStatus: "success",
          lastError: null,
        });
      }
    }

    // 有跳过就不能报 success —— 以前这里无条件写 success,于是「水位推过了被跳过的
    // 文件」这件事在 sync_state 里完全看不出来。codex 那条管子静默失效两周才被发现,
    // 就是同一类问题的另一个面。
    const skipNotes: string[] = [];
    if (dirListFailure) {
      skipNotes.push(`project 目录列举失败,本轮不推水位: ${dirListFailure}`);
    }
    if (runFirstFailureMtime !== null) {
      skipNotes.push(
        `有文件解析失败,水位钳在 mtime ${runFirstFailureMtime} 之前,下轮重试`
      );
    }
    const degraded = skipNotes.length > 0;
    setSyncState(db, "claude", {
      watermarkMs: watermark,
      lastRunAt: nowIso,
      lastStatus: degraded ? "partial" : "success",
      lastError: degraded ? skipNotes.join(" | ") : null,
    });
    return {
      status: degraded ? "partial" : "success",
      scannedFiles: scanned,
      upserted,
      watermarkMs: watermark,
      ...(degraded ? { error: skipNotes.join(" | ") } : {}),
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    setSyncState(db, "claude", {
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
