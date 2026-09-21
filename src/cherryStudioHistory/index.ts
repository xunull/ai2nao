import { existsSync } from "node:fs";
import type { ChatSession, ChatSessionSummary, SearchResult } from "../cursorHistory/types.js";
import {
  CHERRY_STUDIO_MIN_VERSION,
  countTopics,
  listTopics,
  loadTopic,
  openCherryStudioDb,
  searchMessages,
} from "./db.js";
import {
  cherryStudioDbPath,
  resolveCherryStudioRoot,
} from "./paths.js";

export { resolveCherryStudioRoot, cherryStudioDbPath };

/**
 * Cherry Studio 的读取入口。**只认 `Data/cherrystudio.sqlite`**(2.0.14 起)。
 *
 * 2.0.14 之前数据散在 IndexedDB 的 leveldb、`Data/agents.db` 与可选的 Markdown
 * 导出目录里,曾经三条路径各有一个 id 前缀。那三条已经删干净 ——
 * 见 docs/adr/0003-cherry-studio-sqlite.md。
 *
 * 会话 id 就是 topic id,不带前缀:只剩一条源之后,前缀除了误导没有别的作用
 * (它指的还是一个已经不存在的存储)。
 */

export type CherryStudioHistoryStatus = {
  platform: NodeJS.Platform;
  cherryRoot: string;
  dbPath: string;
  dbMissing: boolean;
  topicCount: number | null;
  warnings?: string[];
};

export type CherryStudioListResult = {
  ok: true;
  cherryRoot: string;
  dbPath: string;
  topicCount: number;
  diagnostics: Array<{ kind: string; message: string; path?: string }>;
  total: number;
  limit: number;
  offset: number;
  sessions: ChatSessionSummary[];
};

export type CherryStudioListOptions = {
  limit?: number;
  offset?: number;
};

/** 库不在时的说法。要点名版本 —— 否则用户只会看到一个空列表,不知道为什么。 */
const MISSING_MESSAGE =
  `未找到 Cherry Studio 的数据库。需要 Cherry Studio ${CHERRY_STUDIO_MIN_VERSION} 或更新版本` +
  `（更早的版本把对话存在 IndexedDB 里，本程序已不再读取那种格式）。`;

export async function getCherryStudioStatus(root?: string): Promise<CherryStudioHistoryStatus> {
  const cherryRoot = resolveCherryStudioRoot(root);
  const dbPath = cherryStudioDbPath(cherryRoot);
  const dbMissing = !existsSync(dbPath);
  if (dbMissing) {
    return {
      platform: process.platform,
      cherryRoot,
      dbPath,
      dbMissing: true,
      topicCount: null,
      warnings: [MISSING_MESSAGE],
    };
  }
  const db = openCherryStudioDb(dbPath);
  try {
    return {
      platform: process.platform,
      cherryRoot,
      dbPath,
      dbMissing: false,
      topicCount: countTopics(db),
    };
  } finally {
    db.close();
  }
}

export async function listCherryStudioSessions(
  root?: string,
  options: CherryStudioListOptions = {}
): Promise<CherryStudioListResult> {
  const cherryRoot = resolveCherryStudioRoot(root);
  const dbPath = cherryStudioDbPath(cherryRoot);
  if (!existsSync(dbPath)) {
    return {
      ok: true,
      cherryRoot,
      dbPath,
      topicCount: 0,
      diagnostics: [{ kind: "dbMissing", message: MISSING_MESSAGE, path: dbPath }],
      total: 0,
      limit: 0,
      offset: 0,
      sessions: [],
    };
  }

  const db = openCherryStudioDb(dbPath);
  try {
    const sessions = listTopics(db);
    const total = sessions.length;
    const limit = normalizeLimit(options.limit, total);
    const offset = normalizeOffset(options.offset);
    return {
      ok: true,
      cherryRoot,
      dbPath,
      topicCount: total,
      diagnostics: [],
      total,
      limit,
      offset,
      sessions: options.limit == null ? sessions : sessions.slice(offset, offset + limit),
    };
  } finally {
    db.close();
  }
}

export async function loadCherryStudioSession(
  sessionId: string,
  root?: string
): Promise<{ session: ChatSession | null; warnings: string[] }> {
  const dbPath = cherryStudioDbPath(resolveCherryStudioRoot(root));
  if (!existsSync(dbPath)) return { session: null, warnings: [MISSING_MESSAGE] };
  const db = openCherryStudioDb(dbPath);
  try {
    return { session: loadTopic(db, sessionId), warnings: [] };
  } finally {
    db.close();
  }
}

export async function searchCherryStudioSessions(
  query: string,
  options: { limit?: number; contextChars?: number; root?: string } = {}
): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  const dbPath = cherryStudioDbPath(resolveCherryStudioRoot(options.root));
  if (!existsSync(dbPath)) return [];
  const db = openCherryStudioDb(dbPath);
  try {
    return searchMessages(db, query, {
      limit: Math.max(1, Math.min(200, options.limit ?? 30)),
      contextChars: Math.max(20, Math.min(500, options.contextChars ?? 120)),
    });
  } finally {
    db.close();
  }
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
