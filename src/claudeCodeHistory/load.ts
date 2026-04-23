import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ChatSessionSummary } from "../cursorHistory/types.js";
import { MAX_JSONL_BYTES, MAX_JSONL_LINES } from "./constants.js";
import { assertPathInsideRoot, listSessionJsonlFiles } from "./discover.js";
import { buildClaudeSession, type BuiltClaudeSession } from "./normalize.js";
import { parseJsonlText } from "./parseJsonl.js";

export class ClaudeTranscriptTooLargeError extends Error {
  readonly code = "CLAUDE_TRANSCRIPT_TOO_LARGE";
  constructor(message: string) {
    super(message);
    this.name = "ClaudeTranscriptTooLargeError";
  }
}

async function readAndParseFile(
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
  projectId: string
): Promise<ChatSessionSummary[]> {
  const base = resolve(projectsRoot);
  const projectPath = assertPathInsideRoot(base, join(base, projectId));
  const files = await listSessionJsonlFiles(projectPath);
  const summaries: ChatSessionSummary[] = [];

  for (const f of files) {
    try {
      const st = await stat(f.filePath);
      if (st.size > MAX_JSONL_BYTES) {
        summaries.push({
          id: f.id,
          index: 0,
          title: "(文件过大)",
          createdAt: new Date(f.mtimeMs),
          lastUpdatedAt: new Date(f.mtimeMs),
          messageCount: 0,
          workspaceId: projectId,
          workspacePath: projectId,
          preview: `>${MAX_JSONL_BYTES} bytes，仅详情可尝试加载`,
        });
        continue;
      }
      const text = await readFile(f.filePath, "utf8");
      if (text.split("\n").length > MAX_JSONL_LINES) {
        summaries.push({
          id: f.id,
          index: 0,
          title: "(行数过多)",
          createdAt: new Date(f.mtimeMs),
          lastUpdatedAt: new Date(f.mtimeMs),
          messageCount: 0,
          workspaceId: projectId,
          workspacePath: projectId,
          preview: `>${MAX_JSONL_LINES} lines`,
        });
        continue;
      }
      const parse = parseJsonlText(text);
      const { summary } = buildClaudeSession({
        projectId,
        sessionId: f.id,
        parse,
        fileMtimeMs: f.mtimeMs,
      });
      summaries.push(summary);
    } catch {
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
