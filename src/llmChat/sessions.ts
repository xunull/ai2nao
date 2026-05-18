import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Message } from "@ag-ui/client";

const MAX_MESSAGES = 200;
const MAX_SYNC_RAW_BYTES = 1_500_000;
const PREVIEW_LEN = 140;
const AG_UI_ROLES = new Set([
  "developer",
  "system",
  "user",
  "assistant",
  "tool",
  "activity",
  "reasoning",
]);

export type LlmChatSessionSummary = {
  id: string;
  title: string;
  protocol?: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  message_count: number;
};

export type LlmChatMessageRow = {
  id: string;
  session_id: string;
  message_id: string;
  message_index: number;
  role: "developer" | "system" | "user" | "assistant" | "tool" | "activity" | "reasoning";
  raw_json: string;
  plain_text: string;
  preview: string;
  status: string | null;
  created_at: string;
  updated_at: string;
};

export type LlmChatSessionDetail = LlmChatSessionSummary & {
  messages: LlmChatMessageRow[];
};

export type PersistLlmChatMessagesInput = {
  title?: unknown;
  messages: Message[];
};

export class LlmChatSessionError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function listLlmChatSessions(
  db: Database.Database,
  limit = 50
): LlmChatSessionSummary[] {
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit) || 50));
  return db
    .prepare(
      `SELECT id, title, protocol, created_at, updated_at, last_message_at, message_count
       FROM llm_chat_sessions
       ORDER BY COALESCE(last_message_at, updated_at) DESC, updated_at DESC
       LIMIT ?`
    )
    .all(safeLimit) as LlmChatSessionSummary[];
}

export function createLlmChatSession(
  db: Database.Database,
  title?: string
): LlmChatSessionSummary {
  const now = new Date().toISOString();
  const id = randomUUID();
  const cleanTitle = cleanSessionTitle(title) ?? "新对话";
  db.prepare(
    `INSERT INTO llm_chat_sessions (
      id, title, protocol, created_at, updated_at, last_message_at, message_count
    ) VALUES (?, ?, 'copilotkit-agui', ?, ?, NULL, 0)`
  ).run(id, cleanTitle, now, now);
  const detail = getLlmChatSession(db, id);
  if (!detail) throw new LlmChatSessionError(500, "failed to create session");
  return detail;
}

export function getLlmChatSession(
  db: Database.Database,
  id: string
): LlmChatSessionDetail | null {
  const session = db
    .prepare(
      `SELECT id, title, protocol, created_at, updated_at, last_message_at, message_count
       FROM llm_chat_sessions
       WHERE id = ?`
    )
    .get(id) as LlmChatSessionSummary | undefined;
  if (!session) return null;
  const messages = db
    .prepare(
      `SELECT id, session_id, message_id, message_index, role, raw_json,
              plain_text, preview, status, created_at, updated_at
       FROM llm_chat_messages
       WHERE session_id = ?
       ORDER BY message_index ASC`
    )
    .all(id) as LlmChatMessageRow[];
  return { ...session, messages };
}

export function ensureLlmChatSession(
  db: Database.Database,
  id: string,
  title?: string
): LlmChatSessionSummary {
  const existing = getLlmChatSession(db, id);
  if (existing) return existing;
  const now = new Date().toISOString();
  const cleanTitle = cleanSessionTitle(title) ?? "新对话";
  db.prepare(
    `INSERT INTO llm_chat_sessions (
      id, title, protocol, created_at, updated_at, last_message_at, message_count
    ) VALUES (?, ?, 'copilotkit-agui', ?, ?, NULL, 0)`
  ).run(id, cleanTitle, now, now);
  const created = getLlmChatSession(db, id);
  if (!created) throw new LlmChatSessionError(500, "failed to create session");
  return created;
}

export function deleteLlmChatSession(db: Database.Database, id: string): boolean {
  const info = db.prepare("DELETE FROM llm_chat_sessions WHERE id = ?").run(id);
  return info.changes > 0;
}

export function replaceLlmChatSessionMessages(
  db: Database.Database,
  sessionId: string,
  input: PersistLlmChatMessagesInput
): LlmChatSessionDetail {
  const row = db
    .prepare("SELECT id, title FROM llm_chat_sessions WHERE id = ?")
    .get(sessionId) as { id: string; title: string } | undefined;
  if (!row) throw new LlmChatSessionError(404, "session not found");
  if (input.messages.length > MAX_MESSAGES) {
    throw new LlmChatSessionError(
      413,
      `too many messages; max ${MAX_MESSAGES}`
    );
  }

  const now = new Date().toISOString();
  const normalized = input.messages.map((raw, index) =>
    normalizeAgUiMessage(raw, index, now)
  );
  const rawBytes = normalized.reduce((sum, msg) => sum + msg.raw_json.length, 0);
  if (rawBytes > MAX_SYNC_RAW_BYTES) {
    throw new LlmChatSessionError(413, "session payload is too large");
  }

  const explicitTitle = cleanSessionTitle(input.title);
  const title = explicitTitle ?? autoTitle(normalized) ?? row.title;
  const lastMessageAt = normalized.length > 0 ? now : null;
  const visibleMessageCount = normalized.filter(isHumanVisibleMessage).length;
  const incomingIds = new Set(normalized.map((m) => m.message_id));

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE llm_chat_sessions
       SET title = ?, updated_at = ?, last_message_at = ?, message_count = ?
       WHERE id = ?`
    ).run(title, now, lastMessageAt, visibleMessageCount, sessionId);

    const existing = db
      .prepare("SELECT message_id FROM llm_chat_messages WHERE session_id = ?")
      .all(sessionId) as { message_id: string }[];
    const del = db.prepare(
      "DELETE FROM llm_chat_messages WHERE session_id = ? AND message_id = ?"
    );
    for (const msg of existing) {
      if (!incomingIds.has(msg.message_id)) del.run(sessionId, msg.message_id);
    }

    db.prepare(
      `UPDATE llm_chat_messages
       SET message_index = -1000000 - message_index
       WHERE session_id = ?`
    ).run(sessionId);

    const upsert = db.prepare(
      `INSERT INTO llm_chat_messages (
        id, session_id, message_id, message_index, role, raw_json, plain_text,
        preview, status, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(session_id, message_id) DO UPDATE SET
        message_index = excluded.message_index,
        role = excluded.role,
        raw_json = excluded.raw_json,
        plain_text = excluded.plain_text,
        preview = excluded.preview,
        status = excluded.status,
        updated_at = excluded.updated_at`
    );

    for (const msg of normalized) {
      upsert.run(
        `${sessionId}:${msg.message_id}`,
        sessionId,
        msg.message_id,
        msg.message_index,
        msg.role,
        msg.raw_json,
        msg.plain_text,
        msg.preview,
        msg.status,
        now,
        now
      );
    }
  });
  tx();

  const detail = getLlmChatSession(db, sessionId);
  if (!detail) throw new LlmChatSessionError(500, "failed to reload session");
  return detail;
}

function normalizeAgUiMessage(raw: Message, index: number, now: string) {
  if (!raw || typeof raw !== "object") {
    throw new LlmChatSessionError(400, `message at index ${index} must be an object`);
  }
  const role = typeof raw.role === "string" ? raw.role : "";
  if (!AG_UI_ROLES.has(role)) {
    throw new LlmChatSessionError(
      400,
      `message at index ${index} has unsupported role ${String(raw.role)}`
    );
  }
  const msg = raw as Message & { id?: string; role: string };
  if (!msg.id?.trim()) {
    throw new LlmChatSessionError(400, `message at index ${index} is missing id`);
  }
  const rawJson = JSON.stringify(msg);
  const plainText = textFromAgUiMessage(msg);
  const preview = previewForAgUiMessage(msg, plainText);
  return {
    message_id: msg.id.trim(),
    message_index: index,
    role: msg.role,
    raw_json: rawJson,
    plain_text: plainText,
    preview,
    status: extractStatus(msg),
    created_at: now,
    updated_at: now,
  };
}

export function agUiMessagesFromSession(detail: LlmChatSessionDetail): Message[] {
  return detail.messages.map((row) => JSON.parse(row.raw_json) as Message);
}

export function textFromAgUiMessage(message: Message): string {
  const content = "content" in message ? message.content : "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && part.type === "text") {
          return part.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function cleanSessionTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
}

function autoTitle(messages: Array<{ role: string; plain_text: string }>): string | null {
  const user = messages.find((m) => m.role === "user" && m.plain_text.trim());
  return cleanSessionTitle(user?.plain_text ?? null);
}

function isHumanVisibleMessage(message: { role: string; plain_text: string }): boolean {
  return ["user", "assistant"].includes(message.role) && Boolean(message.plain_text.trim());
}

function previewForAgUiMessage(message: Message & { role: string }, plainText: string): string {
  if (message.role === "assistant" && "toolCalls" in message && message.toolCalls?.length) {
    const names = message.toolCalls
      .map((call) => call.function?.name)
      .filter((name): name is string => Boolean(name))
      .slice(0, 3);
    return names.length > 0 ? `[tool call] ${names.join(", ")}` : "[tool call]";
  }

  if (message.role === "tool") {
    return previewToolContent("content" in message ? message.content : "");
  }

  if (message.role === "activity") return "[activity]";
  if (message.role === "reasoning") return "[reasoning]";
  return previewText(plainText);
}

function previewToolContent(content: unknown): string {
  if (typeof content !== "string" || !content.trim()) return "[tool result]";
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object") {
      const rec = parsed as Record<string, unknown>;
      const kind = typeof rec.kind === "string" ? rec.kind : "tool result";
      const source = typeof rec.source === "string" ? rec.source : null;
      const evidence = Array.isArray(rec.evidence) ? rec.evidence : [];
      if (kind === "evidence") {
        return `[evidence] ${source ? `${source} · ` : ""}${evidence.length} result${evidence.length === 1 ? "" : "s"}`;
      }
      if (kind === "evidence_error") {
        const code = typeof rec.code === "string" ? rec.code : "error";
        return `[evidence error] ${source ? `${source} · ` : ""}${code}`;
      }
    }
  } catch {
    // Plain text tool results still get a compact preview.
  }
  return previewText(content) || "[tool result]";
}

function previewText(value: string): string {
  const t = value.trim().replace(/\s+/g, " ");
  return t.length > PREVIEW_LEN ? `${t.slice(0, PREVIEW_LEN - 3)}...` : t;
}

function extractStatus(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const status = (raw as Record<string, unknown>).status;
  if (typeof status === "string") return status;
  if (status && typeof status === "object") {
    const type = (status as Record<string, unknown>).type;
    return typeof type === "string" ? type : null;
  }
  return null;
}
