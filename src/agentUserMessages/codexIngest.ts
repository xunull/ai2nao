/**
 * Codex → agent_user_messages 摄取(v1.1)。
 *
 * 增量(D9):按 rollout jsonl 文件 mtime 水位 `>=` 过滤,分批 upsert + 逐批推水位。
 * 口径:共享 extractCodexUserMessages(含 event_msg 双重门 + exec 样板剥离,与抽屉端点同源)。
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
  extractCodexUserMessages,
} from "../codexHistory/myMessages.js";
import { codexSessionsRoot, resolveCodexRoot } from "../codexHistory/paths.js";
import { slugFromPath } from "./projectKey.js";
import { getSyncState, setSyncState, upsertUserMessagesBatch } from "./store.js";
import type { UpsertUserMessageInput } from "./types.js";

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
        } catch {
          continue; // 单文件坏/过大 → 跳过
        }
        if (!built) continue;
        const codexMeta = built.session.metadata?.codex as
          | { programmatic?: boolean }
          | undefined;
        const programmatic = codexMeta?.programmatic ?? false;
        // 从 session cwd 回填 project(slug,与 claude 对齐;供对话↔提交桥归属)。
        const project = slugFromPath(built.session.workspacePath);
        for (const ex of extractCodexUserMessages(built.session.messages, {
          programmatic,
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
          });
        }
        if (f.mtimeMs > batchMaxMs) batchMaxMs = f.mtimeMs;
      }

      upserted += upsertUserMessagesBatch(db, rows, nowIso);
      if (batchMaxMs > watermark) {
        watermark = batchMaxMs;
        setSyncState(db, "codex", {
          watermarkMs: watermark,
          lastRunAt: nowIso,
          lastStatus: "success",
          lastError: truncated ? `truncated at ${MAX_FILES} files` : null,
        });
      }
    }

    setSyncState(db, "codex", {
      watermarkMs: watermark,
      lastRunAt: nowIso,
      lastStatus: "success",
      lastError: truncated ? `truncated at ${MAX_FILES} files` : null,
    });
    return { status: "success", scannedFiles: scanned, upserted, watermarkMs: watermark, truncated };
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
