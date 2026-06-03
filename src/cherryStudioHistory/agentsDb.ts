import { existsSync } from "node:fs";
import BetterSqlite from "better-sqlite3";
import type Database from "better-sqlite3";
import type {
  ChatSession,
  ChatSessionSummary,
  Message,
} from "../cursorHistory/types.js";

type AgentSessionRow = {
  id: string;
  agent_type: string;
  agent_id: string;
  name: string;
  description: string | null;
  model: string;
  created_at: string;
  updated_at: string;
};

type AgentMessageRow = {
  id: number;
  session_id: string;
  role: string;
  content: string;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  agent_session_id: string | null;
};

export type CherryAgentDbResult = {
  sessions: ChatSessionSummary[];
  warnings: string[];
};

export function listCherryAgentSessions(dbPath: string): CherryAgentDbResult {
  if (!existsSync(dbPath)) {
    return { sessions: [], warnings: [`agents.db not found: ${dbPath}`] };
  }
  const db = openCherryAgentsDb(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT id, agent_type, agent_id, name, description, model, created_at, updated_at
         FROM sessions
         ORDER BY datetime(updated_at) DESC, id ASC`
      )
      .all() as AgentSessionRow[];
    const countStmt = db.prepare("SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?");
    const firstStmt = db.prepare(
      `SELECT content FROM session_messages
       WHERE session_id = ?
       ORDER BY datetime(created_at) ASC, id ASC
       LIMIT 1`
    );
    const sessions = rows.map((row, index) => {
      const countRow = countStmt.get(row.id) as { count: number };
      const first = firstStmt.get(row.id) as { content?: string } | undefined;
      return summaryFromAgentRow(row, index + 1, countRow.count, first?.content ?? "");
    });
    return { sessions, warnings: [] };
  } finally {
    db.close();
  }
}

export function loadCherryAgentSession(dbPath: string, sessionId: string): ChatSession | null {
  if (!existsSync(dbPath)) return null;
  const db = openCherryAgentsDb(dbPath);
  try {
    const row = db
      .prepare(
        `SELECT id, agent_type, agent_id, name, description, model, created_at, updated_at
         FROM sessions
         WHERE id = ?`
      )
      .get(sessionId) as AgentSessionRow | undefined;
    if (!row) return null;
    const messageRows = db
      .prepare(
        `SELECT id, session_id, role, content, metadata, created_at, updated_at, agent_session_id
         FROM session_messages
         WHERE session_id = ?
         ORDER BY datetime(created_at) ASC, id ASC`
      )
      .all(sessionId) as AgentMessageRow[];
    return sessionFromAgentRow(row, messageRows);
  } finally {
    db.close();
  }
}

function openCherryAgentsDb(dbPath: string): Database.Database {
  return new BetterSqlite(dbPath, { readonly: true, fileMustExist: true });
}

function summaryFromAgentRow(
  row: AgentSessionRow,
  index: number,
  messageCount: number,
  preview: string
): ChatSessionSummary {
  return {
    id: `agent:${row.id}`,
    index,
    title: row.name || row.id,
    createdAt: dateOrFallback(row.created_at),
    lastUpdatedAt: dateOrFallback(row.updated_at),
    messageCount,
    workspaceId: "cherry-studio-agent",
    workspacePath: row.agent_id,
    preview: preview || row.description || "",
    source: "cherry-studio",
    metadata: {
      cherryStudio: {
        kind: "agents-db",
        sessionId: row.id,
        agentType: row.agent_type,
        agentId: row.agent_id,
        model: row.model,
      },
    },
  };
}

function sessionFromAgentRow(row: AgentSessionRow, messageRows: AgentMessageRow[]): ChatSession {
  const messages = messageRows.map((message): Message => {
    const role = message.role === "user" ? "user" : "assistant";
    return {
      id: String(message.id),
      role,
      content: contentFromAgentMessage(message.content),
      timestamp: dateOrFallback(message.created_at),
      codeBlocks: [],
      metadata: {
        cherryMessageMetadata: parseJsonObject(message.metadata),
        cherryAgentSessionId: message.agent_session_id ?? undefined,
      },
    };
  });

  return {
    id: `agent:${row.id}`,
    index: 0,
    title: row.name || row.id,
    createdAt: dateOrFallback(row.created_at),
    lastUpdatedAt: dateOrFallback(row.updated_at),
    messageCount: messages.length,
    messages,
    workspaceId: "cherry-studio-agent",
    workspacePath: row.agent_id,
    source: "cherry-studio",
    metadata: {
      cherryStudio: {
        kind: "agents-db",
        sessionId: row.id,
        agentType: row.agent_type,
        agentId: row.agent_id,
        model: row.model,
      },
    },
  };
}

function contentFromAgentMessage(content: string): string {
  const clean = content.trim();
  if (!clean.startsWith("{")) return clean;
  const parsed = parseJsonObject(clean);
  if (!parsed) return clean;
  for (const key of ["text", "content", "message", "result"]) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return clean;
}

function parseJsonObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function dateOrFallback(value: string): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}
