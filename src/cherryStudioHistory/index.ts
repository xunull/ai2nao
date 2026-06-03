import { existsSync } from "node:fs";
import {
  cherryStudioAgentsDbPath,
  cherryStudioIndexedDbPath,
  resolveCherryStudioExportRoot,
  resolveCherryStudioRoot,
} from "./paths.js";
import { listCherryAgentSessions, loadCherryAgentSession } from "./agentsDb.js";
import {
  countCherryIndexedDbTopics,
  listCherryIndexedDbSessions,
  loadCherryIndexedDbSession,
} from "./indexedDb.js";
import {
  listCherryMarkdownSessions,
  loadCherryMarkdownSession,
} from "./markdownExport.js";
import type { ChatSessionSummary, SearchResult, SearchSnippet } from "../cursorHistory/types.js";

export {
  resolveCherryStudioRoot,
  resolveCherryStudioExportRoot,
  cherryStudioAgentsDbPath,
  cherryStudioIndexedDbPath,
};

export type CherryStudioHistoryStatus = {
  platform: NodeJS.Platform;
  cherryRoot: string;
  agentsDbPath: string;
  indexedDbPath: string;
  exportRoot?: string;
  indexedDbAvailable: boolean;
  indexedDbMissing: boolean;
  indexedDbTopicCount: number | null;
  agentDbMissing: boolean;
  exportRootMissing: boolean;
  envCherryStudioExportRoot: boolean;
  warnings?: string[];
};

export type CherryStudioListResult = {
  ok: true;
  cherryRoot: string;
  agentsDbPath: string;
  indexedDbPath: string;
  indexedDbTopicCount: number;
  exportRoot?: string;
  diagnostics: Array<{ kind: string; message: string; path?: string }>;
  scannedCount: number;
  truncated: boolean;
  total: number;
  limit: number;
  offset: number;
  sessions: ChatSessionSummary[];
};

export type CherryStudioListOptions = {
  limit?: number;
  offset?: number;
};

export async function getCherryStudioStatus(root?: string, exportRoot?: string): Promise<CherryStudioHistoryStatus> {
  const cherryRoot = resolveCherryStudioRoot(root);
  const resolvedExportRoot = resolveCherryStudioExportRoot(exportRoot);
  const agentsDbPath = cherryStudioAgentsDbPath(cherryRoot);
  const indexedDbPath = cherryStudioIndexedDbPath(cherryRoot);
  const indexedDbMissing = !existsPath(indexedDbPath);
  let indexedDbTopicCount: number | null = null;
  let warnings: string[] = [];
  if (!indexedDbMissing) {
    const counted = await countCherryIndexedDbTopics(cherryRoot);
    indexedDbTopicCount = counted.count;
    warnings = counted.warnings;
  }
  return {
    platform: process.platform,
    cherryRoot,
    agentsDbPath,
    indexedDbPath,
    exportRoot: resolvedExportRoot,
    indexedDbAvailable: !indexedDbMissing && indexedDbTopicCount !== null && warnings.length === 0,
    indexedDbMissing,
    indexedDbTopicCount,
    agentDbMissing: !existsPath(agentsDbPath),
    exportRootMissing: !resolvedExportRoot || !existsPath(resolvedExportRoot),
    envCherryStudioExportRoot: Boolean(process.env.CHERRY_STUDIO_EXPORT_ROOT),
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export async function listCherryStudioSessions(
  root?: string,
  exportRoot?: string,
  options: CherryStudioListOptions = {}
): Promise<CherryStudioListResult> {
  const status = await getCherryStudioStatus(root, exportRoot);
  const diagnostics: CherryStudioListResult["diagnostics"] = [];
  const indexed = await listCherryIndexedDbSessions(status.cherryRoot);
  for (const warning of indexed.warnings) {
    diagnostics.push({ kind: "indexedDbWarning", message: warning, path: status.indexedDbPath });
  }
  const agent = listCherryAgentSessions(status.agentsDbPath);
  for (const warning of agent.warnings) {
    diagnostics.push({ kind: "agentDbMissing", message: warning, path: status.agentsDbPath });
  }
  const exported = await listCherryMarkdownSessions(status.exportRoot);
  for (const warning of exported.warnings) {
    diagnostics.push({
      kind: warning.includes("not configured") ? "exportRootMissing" : "exportWarning",
      message: warning,
      path: status.exportRoot,
    });
  }
  const sessions = [...indexed.sessions, ...agent.sessions, ...exported.sessions].sort(
    (a, b) =>
      b.lastUpdatedAt.getTime() - a.lastUpdatedAt.getTime() ||
      a.id.localeCompare(b.id)
  );
  sessions.forEach((session, index) => {
    session.index = index + 1;
  });
  const total = sessions.length;
  const limit = normalizeLimit(options.limit, total);
  const offset = normalizeOffset(options.offset);
  const page = options.limit == null ? sessions : sessions.slice(offset, offset + limit);
  return {
    ok: true,
    cherryRoot: status.cherryRoot,
    agentsDbPath: status.agentsDbPath,
    indexedDbPath: status.indexedDbPath,
    indexedDbTopicCount: indexed.topicCount,
    exportRoot: status.exportRoot,
    diagnostics,
    scannedCount: indexed.topicCount + agent.sessions.length + exported.scannedCount,
    truncated: exported.truncated,
    total,
    limit,
    offset,
    sessions: page,
  };
}

export async function loadCherryStudioSession(
  sessionId: string,
  root?: string,
  exportRoot?: string
) {
  const status = await getCherryStudioStatus(root, exportRoot);
  if (sessionId.startsWith("indexeddb:")) {
    return loadCherryIndexedDbSession(status.cherryRoot, sessionId);
  }
  if (sessionId.startsWith("agent:")) {
    return {
      session: loadCherryAgentSession(status.agentsDbPath, sessionId.slice("agent:".length)),
      warnings: [] as string[],
    };
  }
  if (sessionId.startsWith("export:") && status.exportRoot) {
    return loadCherryMarkdownSession(status.exportRoot, sessionId);
  }
  return { session: null, warnings: [] as string[] };
}

export async function searchCherryStudioSessions(
  query: string,
  options: { limit?: number; contextChars?: number; root?: string; exportRoot?: string } = {}
): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const list = await listCherryStudioSessions(options.root, options.exportRoot);
  const limit = Math.max(1, Math.min(200, options.limit ?? 30));
  const contextChars = Math.max(20, Math.min(500, options.contextChars ?? 120));
  const results: SearchResult[] = [];

  for (const summary of list.sessions) {
    const detail = await loadCherryStudioSession(summary.id, options.root, options.exportRoot).catch(() => null);
    const session = detail?.session;
    if (!session) continue;
    const snippets: SearchSnippet[] = [];
    for (const message of session.messages) {
      const lower = message.content.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx < 0) continue;
      snippets.push({
        messageRole: message.role,
        text: snippetAround(message.content, idx, query.length, contextChars),
        matchPositions: [[Math.max(0, idx), idx + query.length]],
      });
      if (snippets.length >= 3) break;
    }
    if (snippets.length === 0) continue;
    results.push({
      sessionId: summary.id,
      index: summary.index,
      workspacePath: summary.workspacePath,
      createdAt: summary.createdAt,
      matchCount: snippets.length,
      snippets,
    });
    if (results.length >= limit) break;
  }
  return results;
}

function snippetAround(text: string, idx: number, queryLength: number, contextChars: number): string {
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + queryLength + contextChars);
  return `${start > 0 ? "..." : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "..." : ""}`;
}

function existsPath(path: string): boolean {
  return Boolean(path) && existsSync(path);
}

function normalizeLimit(raw: number | undefined, total: number): number {
  if (raw == null) return total;
  if (!Number.isFinite(raw)) return 50;
  return Math.max(1, Math.min(200, Math.floor(raw)));
}

function normalizeOffset(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.floor(raw));
}
