import { existsSync } from "node:fs";
import { sessionSummaryToJson } from "../cursorHistory/json.js";
import type { ChatSessionSummary } from "../cursorHistory/types.js";
import { diagnosticFromError, type OpencodeDiagnostic } from "./errors.js";
import { buildOpencodeSession } from "./normalize.js";
import { opencodeDbPath, resolveOpencodeDataDir } from "./paths.js";
import {
  getSessionRowFromDb,
  listProjectsFromDb,
  listSessionRowsFromDb,
  loadSessionMessagesAndParts,
  openOpencodeDb,
} from "./stateDb.js";
import type {
  BuiltOpencodeSession,
  OpencodeListFilters,
  OpencodeListResult,
  OpencodeProjectsResult,
  OpencodeSessionRow,
} from "./types.js";

function summaryFromRow(row: OpencodeSessionRow): ChatSessionSummary {
  return {
    id: row.id,
    index: 0,
    title: row.title || "无标题会话",
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    messageCount: 0, // 列表不读 message，避免 N+1；详情页才有真实条数。
    workspaceId: row.projectId,
    workspacePath: row.directory,
    preview: "",
    source: "opencode",
    metadata: {
      opencode: {
        directory: row.directory,
        agent: row.agent,
        model: row.model,
        archived: row.archived,
        tokensInput: row.tokensInput,
        tokensOutput: row.tokensOutput,
        cost: row.cost,
      },
    },
  };
}

export async function listOpencodeProjects(
  rawDataDir: string | undefined,
  filters: Pick<OpencodeListFilters, "archived">
): Promise<OpencodeProjectsResult> {
  const dataDir = resolveOpencodeDataDir(rawDataDir);
  const dbPath = opencodeDbPath(dataDir);
  const diagnostics: OpencodeDiagnostic[] = [];

  if (!existsSync(dbPath)) {
    return {
      ok: true,
      source: "sqlite",
      dbPath,
      diagnostics: [{ kind: "db-not-found", message: "opencode.db not found", path: dbPath }],
      projects: [],
    };
  }

  let db;
  try {
    db = openOpencodeDb(dbPath);
    const projects = listProjectsFromDb(db, dbPath, filters);
    return { ok: true, source: "sqlite", dbPath, diagnostics, projects };
  } catch (e) {
    diagnostics.push(diagnosticFromError(e));
    return { ok: true, source: "sqlite", dbPath, diagnostics, projects: [] };
  } finally {
    db?.close();
  }
}

export async function listOpencodeSessionSummaries(
  rawDataDir: string | undefined,
  filters: OpencodeListFilters
): Promise<OpencodeListResult> {
  const dataDir = resolveOpencodeDataDir(rawDataDir);
  const dbPath = opencodeDbPath(dataDir);
  const diagnostics: OpencodeDiagnostic[] = [];

  if (!existsSync(dbPath)) {
    return {
      ok: true,
      source: "sqlite",
      dbPath,
      diagnostics: [{ kind: "db-not-found", message: "opencode.db not found", path: dbPath }],
      sessions: [],
    };
  }

  let db;
  try {
    db = openOpencodeDb(dbPath);
    const rows = listSessionRowsFromDb(db, dbPath, filters);
    return {
      ok: true,
      source: "sqlite",
      dbPath,
      diagnostics,
      sessions: rows.map(summaryFromRow),
    };
  } catch (e) {
    diagnostics.push(diagnosticFromError(e));
    return { ok: true, source: "sqlite", dbPath, diagnostics, sessions: [] };
  } finally {
    db?.close();
  }
}

export async function loadOpencodeSessionDetail(
  rawDataDir: string | undefined,
  sessionId: string
): Promise<BuiltOpencodeSession | null> {
  const dataDir = resolveOpencodeDataDir(rawDataDir);
  const dbPath = opencodeDbPath(dataDir);
  if (!existsSync(dbPath)) return null;

  let db;
  try {
    db = openOpencodeDb(dbPath);
    const row = getSessionRowFromDb(db, dbPath, sessionId);
    if (!row) return null;
    const { messages, parts } = loadSessionMessagesAndParts(db, dbPath, sessionId);
    return buildOpencodeSession({ row, messages, parts });
  } finally {
    db?.close();
  }
}

export function opencodeSessionSummaryToJson(s: ChatSessionSummary) {
  return sessionSummaryToJson(s);
}
