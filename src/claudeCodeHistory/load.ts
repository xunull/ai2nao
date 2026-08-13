import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ChatSessionSummary, Message } from "../cursorHistory/types.js";
import { MAX_JSONL_BYTES, MAX_JSONL_LINES } from "./constants.js";
import { assertPathInsideRoot, listSessionJsonlFiles } from "./discover.js";
import {
  buildClaudeSession,
  mapRecordToMessage,
  type BuiltClaudeSession,
} from "./normalize.js";
import { parseJsonlText } from "./parseJsonl.js";
import {
  getSessionIndex,
  readLineRange,
  type SessionHeader,
} from "./sessionIndex.js";
import {
  cleanClaudeUserMessage,
  extractClaudeUserMessages,
} from "./myMessages.js";

export class ClaudeTranscriptTooLargeError extends Error {
  readonly code = "CLAUDE_TRANSCRIPT_TOO_LARGE";
  constructor(message: string) {
    super(message);
    this.name = "ClaudeTranscriptTooLargeError";
  }
}

export async function readAndParseFile(
  filePath: string,
  projectId: string,
  sessionId: string
): Promise<BuiltClaudeSession> {
  const st = await stat(filePath);
  if (st.size > MAX_JSONL_BYTES) {
    throw new ClaudeTranscriptTooLargeError(
      `transcript exceeds ${MAX_JSONL_BYTES} bytes; open in Claude Code or raise the limit`
    );
  }
  const text = await readFile(filePath, "utf8");
  const lineCount = text.split("\n").length;
  if (lineCount > MAX_JSONL_LINES) {
    throw new ClaudeTranscriptTooLargeError(
      `transcript exceeds ${MAX_JSONL_LINES} lines; raise the limit or split the file`
    );
  }
  const parse = parseJsonlText(text);
  return buildClaudeSession({
    projectId,
    sessionId,
    parse,
    fileMtimeMs: st.mtimeMs,
  });
}

export async function listSessionSummaries(
  projectsRoot: string,
  projectId: string,
  options?: { limit?: number }
): Promise<ChatSessionSummary[]> {
  const base = resolve(projectsRoot);
  const projectPath = assertPathInsideRoot(base, join(base, projectId));
  const files = await listSessionJsonlFiles(projectPath);
  const summaries: ChatSessionSummary[] = [];

  const boundedFiles =
    options?.limit != null ? files.slice(0, Math.max(0, options.limit)) : files;

  for (const f of boundedFiles) {
    try {
      // T1c:列表页改用「一次流式扫描」得到的 header,不再整文件 readFile + 全量 parse。
      // 小文件语义与旧版逐字节一致(header 口径与 buildClaudeSession 对齐,见 sessionIndex.ts)。
      const index = await getSessionIndex(f.filePath, {
        fileMtimeMs: f.mtimeMs,
        projectId,
        sessionId: f.id,
      });
      const h = index.header;
      summaries.push({
        id: f.id,
        index: 0,
        title: h.title,
        createdAt: h.createdAt,
        lastUpdatedAt: h.lastUpdatedAt,
        messageCount: h.messageCount,
        workspaceId: projectId,
        workspacePath: h.workspacePath,
        preview: h.preview,
      });
    } catch (e) {
      // 超限:getSessionIndex 抛 ClaudeTranscriptTooLargeError,按「字节/行数」还原旧占位摘要。
      if (e instanceof ClaudeTranscriptTooLargeError) {
        const isBytes = e.message.includes("bytes");
        summaries.push({
          id: f.id,
          index: 0,
          title: isBytes ? "(文件过大)" : "(行数过多)",
          createdAt: new Date(f.mtimeMs),
          lastUpdatedAt: new Date(f.mtimeMs),
          messageCount: 0,
          workspaceId: projectId,
          workspacePath: projectId,
          preview: isBytes
            ? `>${MAX_JSONL_BYTES} bytes，仅详情可尝试加载`
            : `>${MAX_JSONL_LINES} lines`,
        });
        continue;
      }
      summaries.push({
        id: f.id,
        index: 0,
        title: "(读取失败)",
        createdAt: new Date(f.mtimeMs),
        lastUpdatedAt: new Date(f.mtimeMs),
        messageCount: 0,
        workspaceId: projectId,
        workspacePath: projectId,
        preview: "无法解析此会话文件",
      });
    }
  }

  summaries.sort(
    (a, b) =>
      b.lastUpdatedAt.getTime() - a.lastUpdatedAt.getTime() ||
      a.id.localeCompare(b.id)
  );
  summaries.forEach((s, i) => {
    s.index = i + 1;
  });
  return summaries;
}

export async function loadSessionDetail(
  projectsRoot: string,
  projectId: string,
  sessionId: string
): Promise<BuiltClaudeSession | null> {
  const base = resolve(projectsRoot);
  const projectPath = assertPathInsideRoot(base, join(base, projectId));
  const files = await listSessionJsonlFiles(projectPath);
  const hit = files.find((f) => f.id === sessionId);
  if (!hit) return null;
  const built = await readAndParseFile(hit.filePath, projectId, sessionId);
  built.session.index = 0;
  return built;
}

// ─────────────────────── 大 transcript 分页(T1b,viewer-only) ───────────────────────
// 下面两个函数是「详情查看器」的分页专用入口,绝不改动 readAndParseFile /
// loadSessionDetail 的整文件语义(那两个被 sessionMemory / workDashboard /
// loadClaudeMyMessages / agentUserMessages 共用)。它们统一走 getSessionIndex(缓存 +
// 一次流式扫描)+ readLineRange(字节 seek),不整文件重读。

/** loadClaudeSessionMessagePage 的默认页大小与硬上限。 */
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

/** 在 project 目录里按 sessionId 定位磁盘文件行;找不到 → null。 */
async function findSessionFile(
  projectsRoot: string,
  projectId: string,
  sessionId: string
) {
  const base = resolve(projectsRoot);
  const projectPath = assertPathInsideRoot(base, join(base, projectId));
  const files = await listSessionJsonlFiles(projectPath);
  return files.find((f) => f.id === sessionId) ?? null;
}

/**
 * 详情页头部(只要 header,不要消息)。走 getSessionIndex 的流式头部,不整文件重读。
 * 找不到 session → null(路由据此回 404)。header 口径与 buildClaudeSession 完全对齐。
 */
export async function loadClaudeSessionMeta(
  projectsRoot: string,
  projectId: string,
  sessionId: string
): Promise<{ header: SessionHeader } | null> {
  const hit = await findSessionFile(projectsRoot, projectId, sessionId);
  if (!hit) return null;
  const index = await getSessionIndex(hit.filePath, {
    fileMtimeMs: hit.mtimeMs,
    projectId,
    sessionId,
  });
  return { header: index.header };
}

/**
 * 从 `cursor`(物理行号,0-based,oldest→new)向后取一页消息。
 * - `limit` 缺省 {@link DEFAULT_PAGE_LIMIT},上限 {@link MAX_PAGE_LIMIT}。
 * - 用 readLineRange 只回读一段原始物理行,逐行解析后交给 mapRecordToMessage
 *   (传入「1-based 绝对行号」= start+j+1,合成 id 与整文件路径一致)。
 * - 空行/坏行在页内被安静跳过(告警口径已由 header.warnings 承载);只收集非空消息。
 * - 找不到 session → null(路由据此回 404)。
 *
 * **cursor 的语义在两个方向下都是「绝对物理行号」,只是指向不同的边界:**
 *
 * ```
 *   asc  (缺省)   cursor = 本页起始行号,缺省 0        nextCursor = 本页末尾
 *                 [cursor, cursor+limit)              hasMore = end < total
 *
 *   desc          cursor = 本页**右边界**行号          nextCursor = 本页起始
 *                 首次不传 → 用当时的 total            hasMore = start > 0
 *                 [max(0,cursor-limit), cursor) 后 reverse
 * ```
 *
 * desc 刻意用绝对行号而不是「已跳过多少条」:会话可能正在被写入(见 sessionIndex 的
 * 增量续扫),相对量会让 total 一变就把前面拉过的页全冲掉 —— 表现为重复消息 + 新增
 * 内容永不出现,而且不报错。绝对行号免疫这一整类问题。
 *
 * 反过来,文件被**截断**时(sessionIndex 会整文件重建)旧游标可能大于新 total ——
 * 这时游标已失效,返回空页而不是静默 clamp 到新 EOF 再把末页重读一遍。
 */
export async function loadClaudeSessionMessagePage(
  projectsRoot: string,
  projectId: string,
  sessionId: string,
  opts?: { cursor?: number; limit?: number; order?: "asc" | "desc" }
): Promise<{ messages: Message[]; nextCursor: number | null; hasMore: boolean } | null> {
  const hit = await findSessionFile(projectsRoot, projectId, sessionId);
  if (!hit) return null;

  const index = await getSessionIndex(hit.filePath, {
    fileMtimeMs: hit.mtimeMs,
    projectId,
    sessionId,
  });

  const total = index.lineCount;
  const order = opts?.order === "desc" ? "desc" : "asc";
  const limit = Math.max(
    1,
    Math.min(Math.trunc(opts?.limit ?? DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT)
  );

  let start: number;
  let end: number;
  if (order === "desc") {
    // 首次不传 cursor → 从当时的文件末尾开始往回翻。
    const rawEnd = Math.trunc(opts?.cursor ?? total);
    // 游标越过文件末尾 = 文件被截断/重写过,这个游标已经没有意义了。
    // 必须在 clamp 之前判:夹到新 EOF 会把末页再读一遍,产生重复消息与重复 React key。
    if (rawEnd > total) {
      return { messages: [], nextCursor: null, hasMore: false };
    }
    end = Math.max(0, rawEnd);
    start = Math.max(0, end - limit);
  } else {
    start = Math.max(0, Math.min(Math.trunc(opts?.cursor ?? 0), total));
    end = Math.min(start + limit, total);
  }

  const rawLines = await readLineRange(hit.filePath, index, start, end);
  const messages: Message[] = [];
  for (let j = 0; j < rawLines.length; j++) {
    const raw = rawLines[j];
    if (raw.trim() === "") continue; // 空行:跳过(对齐 parseJsonlText)
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // 坏行:安静跳过(header.warnings 已计入解析错误数)
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    // 1-based 绝对物理行号。**基准是 start 不是 cursor** —— desc 下 cursor 指的是
    // 右边界,拿它当行号基准会让合成 id(user-L{n} 等)跨页碰撞。
    const lineNumber = start + j + 1;
    const message = mapRecordToMessage(
      parsed as Record<string, unknown>,
      lineNumber,
      hit.mtimeMs
    );
    if (message) messages.push(message);
  }

  // 页内按物理行号升序读出,desc 下翻成「新 → 旧」。
  if (order === "desc") messages.reverse();

  const hasMore = order === "desc" ? start > 0 : end < total;
  const nextCursor = hasMore ? (order === "desc" ? start : end) : null;
  return { messages, nextCursor, hasMore };
}

export type ClaudeMyMessage = { id: string; timestamp: string; text: string };

/**
 * 「只看我说的」后端权威版(option C:清洗归后端,抽屉只显示)。复用详情加载 +
 * 共享 `extractClaudeUserMessages`(与 ingest 同源),返回清洗后非空的用户消息 +
 * 清洗后的标题。找不到 session → null。
 */
export async function loadClaudeMyMessages(
  projectsRoot: string,
  projectId: string,
  sessionId: string
): Promise<{ messages: ClaudeMyMessage[]; cleanTitle: string } | null> {
  const built = await loadSessionDetail(projectsRoot, projectId, sessionId);
  if (!built) return null;
  const messages = extractClaudeUserMessages(built.session.messages)
    .filter((m) => m.isHuman)
    .map((m) => ({
      id: m.messageKey,
      timestamp: new Date(m.eventAtMs).toISOString(),
      text: m.cleanedText,
    }));
  const cleanTitle = cleanClaudeUserMessage(built.summary.title ?? "");
  return { messages, cleanTitle };
}
