/**
 * Codex → agent_user_messages 摄取(v1.1)。
 *
 * 增量(D9):按 rollout jsonl 文件 mtime 水位 `>=` 过滤,分批 upsert + 逐批推水位。
 * 口径:共享 extractCodexMessages(含三态分流 + event_msg 双重门 + exec 样板剥离,与抽屉
 * 端点同源;抽屉那侧调 extractCodexUserMessages,是同一函数 filter role==='user' 的视图)。
 *
 * 2026-08-18 起连 AI 的话一起收。原来只收 user,且「programmatic 就整场跳过」——
 * 全量实测 349 个会话证明那个布尔门把三种性质不同的会话压成一类:normal(126 会话,
 * AI 正文 13.24 MB)是主体、subagent(137 会话,2.57 MB)的 AI 侧是 codex 写的审查意见
 * 但 user 侧是派活 prompt、exec(86 会话,0.37 MB)两侧都是机器注入。现按三态分别处理。
 * 自然 key:source_session_id = 文件 id(rollout uuid),source_message_key = user-L<line>。
 * 诚实:listCodexTranscriptFiles 有 5000 上限,truncated 时在 summary 标注(不静默丢)。
 */
import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { listCodexTranscriptFiles } from "../codexHistory/discover.js";
import { loadCodexSessionDetail } from "../codexHistory/load.js";
import {
  CODEX_CLEANER_VERSION,
  CODEX_PARSER_VERSION,
  extractCodexMessages,
} from "../codexHistory/myMessages.js";
import { MAX_CODEX_JSONL_BYTES } from "../codexHistory/constants.js";
import { codexSessionsRoot, resolveCodexRoot } from "../codexHistory/paths.js";
import { slugFromPath } from "./projectKey.js";
import { getSyncState, setSyncState, upsertUserMessagesBatch } from "./store.js";
import type { UpsertUserMessageInput } from "./types.js";

/** codex 的「文件太大」是确定性拒绝,与瞬时失败要分开处理(见下面的 catch)。 */
function isTooLarge(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { kind?: unknown }).kind === "transcript-too-large"
  );
}

const BATCH_FILES = 40;
const MAX_FILES = 5000;

export type CodexIngestResult = {
  status: "success" | "partial" | "skipped" | "failed";
  scannedFiles: number;
  upserted: number;
  watermarkMs: number;
  truncated: boolean;
  error?: string;
};

export async function ingestCodexUserMessages(
  db: Database.Database,
  opts?: { codexRoot?: string; now?: Date }
): Promise<CodexIngestResult> {
  const now = opts?.now ?? new Date();
  const nowIso = now.toISOString();
  const codexRoot = resolveCodexRoot(opts?.codexRoot);
  const sessionsRoot = codexSessionsRoot(codexRoot);

  if (!existsSync(sessionsRoot)) {
    return { status: "skipped", scannedFiles: 0, upserted: 0, watermarkMs: 0, truncated: false };
  }

  const state = getSyncState(db, "codex");
  let watermark = state?.watermarkMs ?? 0;

  /**
   * 水位钳制。`7de68d1` 给 claudeIngest 修过同一个缺陷,当时没有同步到这里 ——
   * 于是 codex 这条管子一直带着它:单文件解析失败 → `continue` 跳过 → 批内后面
   * 一个成功的文件把 batchMaxMs 推过去 → 下一轮 `mtimeMs >= watermark` 把它
   * 永久排除,而 lastStatus 照写 success。整条链上没有任何地方会响。
   *
   * 钳制方式与 claudeIngest 一致:取全 run 最小的失败 mtime,把水位拦在它之前。
   * 不能按批算 —— batchMaxMs 每批重置且每批 commit 一次水位,批 N 钳住了,
   * 批 N+1 的文件 mtime 更大,照样推过去。
   */
  let runFirstFailureMtime: number | null = null;
  let tooLarge = 0;
  const noteFileFailure = (mtimeMs: number) => {
    if (runFirstFailureMtime === null || mtimeMs < runFirstFailureMtime) {
      runFirstFailureMtime = mtimeMs;
    }
  };

  let files;
  let truncated = false;
  try {
    const r = await listCodexTranscriptFiles(sessionsRoot, { maxFiles: MAX_FILES });
    files = r.files;
    truncated = r.truncated;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    setSyncState(db, "codex", {
      watermarkMs: watermark,
      lastRunAt: nowIso,
      lastStatus: "failed",
      lastError: error,
    });
    return { status: "failed", scannedFiles: 0, upserted: 0, watermarkMs: watermark, truncated, error };
  }

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
          built = await loadCodexSessionDetail(codexRoot, f.id);
        } catch (e) {
          // 两种跳过要分开:
          //   transcript-too-large  确定性拒绝 —— 文件不会变小,重扫一万次也一样。
          //                         钳水位只会让管子永久卡在它之前,所以**不钳**,
          //                         但计数写进 lastError,不让它变回静默。
          //   其他                  可能是瞬时的(权限、写到一半、磁盘抖动)——
          //                         钳住水位,下轮重试。
          if (isTooLarge(e)) {
            tooLarge++;
          } else {
            noteFileFailure(f.mtimeMs);
          }
          continue;
        }
        if (!built) {
          noteFileFailure(f.mtimeMs);
          continue;
        }
        const codexMeta = built.session.metadata?.codex as
          | { programmatic?: boolean; sessionKind?: "normal" | "subagent" | "exec" }
          | undefined;
        // 三态优先;拿不到时退回旧布尔(true → 按最严格的 exec 处理)。
        const sessionKind =
          codexMeta?.sessionKind ?? (codexMeta?.programmatic ? "exec" : "normal");
        // 从 session cwd 回填 project(slug,与 claude 对齐;供对话↔提交桥归属)。
        const project = slugFromPath(built.session.workspacePath);
        for (const ex of extractCodexMessages(built.session.messages, {
          sessionKind,
        })) {
          rows.push({
            source: "codex",
            sourceSessionId: f.id,
            sourceMessageKey: ex.messageKey,
            project,
            eventAtUtc: new Date(ex.eventAtMs).toISOString(),
            rawText: ex.rawText,
            rawPayloadJson: ex.rawPayloadJson,
            cleanedText: ex.cleanedText,
            isHuman: ex.isHuman,
            cleanerVersion: CODEX_CLEANER_VERSION,
            parserVersion: CODEX_PARSER_VERSION,
            sourcePath: f.filePath,
            role: ex.role,
            answeringUserKey: ex.answeringUserKey,
          });
        }
        if (f.mtimeMs > batchMaxMs) batchMaxMs = f.mtimeMs;
      }

      upserted += upsertUserMessagesBatch(db, rows, nowIso);
      const capped =
        runFirstFailureMtime === null
          ? batchMaxMs
          : Math.min(batchMaxMs, runFirstFailureMtime - 1);
      if (capped > watermark) {
        watermark = capped;
        setSyncState(db, "codex", {
          watermarkMs: watermark,
          lastRunAt: nowIso,
          lastStatus: runFirstFailureMtime === null ? "success" : "partial",
          lastError: truncated ? `truncated at ${MAX_FILES} files` : null,
        });
      }
    }

    // 有跳过就不能报 success —— 以前这里无条件写 success,于是「水位推过了被跳过的
    // 文件」这件事在 sync_state 里完全看不出来。
    const notes: string[] = [];
    if (truncated) notes.push(`truncated at ${MAX_FILES} files`);
    if (tooLarge > 0) {
      notes.push(`${tooLarge} 个会话超过 ${MAX_CODEX_JSONL_BYTES} 字节上限,已跳过(确定性拒绝,不影响水位)`);
    }
    if (runFirstFailureMtime !== null) {
      notes.push(
        `有文件解析失败,水位钳在 mtime ${runFirstFailureMtime} 之前,下轮重试`
      );
    }
    const degraded = runFirstFailureMtime !== null;
    setSyncState(db, "codex", {
      watermarkMs: watermark,
      lastRunAt: nowIso,
      lastStatus: degraded ? "partial" : "success",
      lastError: notes.length > 0 ? notes.join(" | ") : null,
    });
    return {
      status: degraded ? "partial" : "success",
      scannedFiles: scanned,
      upserted,
      watermarkMs: watermark,
      truncated,
      ...(degraded ? { error: notes.join(" | ") } : {}),
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    setSyncState(db, "codex", {
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
      truncated,
      error,
    };
  }
}
