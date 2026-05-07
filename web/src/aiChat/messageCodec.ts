import type { UIMessage } from "ai";
import type { AiChatSessionDetail, AiChatStoredMessage } from "./types";

export type RestoredThreadMessages = {
  messages: UIMessage[];
  errors: string[];
};

export type AiChatThreadMessageLike = {
  id?: string;
  role: "system" | "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
  status?: unknown;
  metadata?: unknown;
};

export function titleFromMessages(messages: readonly unknown[]): string {
  const firstUser = messages.find(
    (message) =>
      message &&
      typeof message === "object" &&
      (message as { role?: unknown }).role === "user" &&
      extractMessageText(message).trim()
  );
  const text = extractMessageText(firstUser).replace(/\s+/g, " ").trim();
  if (!text) return "新对话";
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

export function restoreSessionMessages(session: AiChatSessionDetail): RestoredThreadMessages {
  return restoreStoredMessageRows(session.messages);
}

export function restoreStoredMessageRows(
  messages: readonly AiChatStoredMessage[]
): RestoredThreadMessages {
  const errors: string[] = [];
  const restored = messages.map((message, index) => {
    const raw = restoreRawJsonMessage(message.raw_json, index);
    if (raw.ok) return raw.message;
    errors.push(`${message.message_id}: ${raw.error}`);
    return fallbackStoredMessage(message);
  });
  return { messages: restored, errors };
}

export function encodeMessageForSync(message: unknown, index: number): UIMessage {
  const normalized = normalizeUiMessage(message, index);
  return JSON.parse(JSON.stringify(normalized)) as UIMessage;
}

export function toThreadMessageLike(message: UIMessage): AiChatThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: partsToThreadContent(message.parts),
    status: (message as { status?: unknown }).status,
    metadata: (message as { metadata?: unknown }).metadata,
  };
}

export function validateUiMessage(message: unknown, index = 0): UIMessage {
  return normalizeUiMessage(message, index);
}

export function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as Record<string, unknown>;
  const chunks: string[] = [];
  collectText(m.parts, chunks);
  if (chunks.length === 0) collectText(m.content, chunks);
  return chunks.join("\n").trim();
}

export function messagePreview(message: unknown, max = 140): string {
  const text = extractMessageText(message).replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function restoreRawJsonMessage(
  rawJson: string,
  index: number
): { ok: true; message: UIMessage } | { ok: false; error: string } {
  try {
    return { ok: true, message: normalizeUiMessage(JSON.parse(rawJson), index) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function fallbackStoredMessage(message: AiChatStoredMessage): UIMessage {
  const parts = message.plain_text
    ? [{ type: "text" as const, text: message.plain_text }]
    : [];
  return {
    id: message.message_id,
    role: message.role,
    parts,
  };
}

function normalizeUiMessage(message: unknown, index: number): UIMessage {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error(`message ${index} must be an object`);
  }
  const m = message as Record<string, unknown>;
  if (typeof m.id !== "string" || m.id.trim().length === 0) {
    throw new Error(`message ${index} must have an id`);
  }
  if (m.role !== "system" && m.role !== "user" && m.role !== "assistant") {
    throw new Error(`message ${index} has invalid role`);
  }
  const parts = Array.isArray(m.parts)
    ? m.parts
    : threadContentToParts(m.content, index);
  parts.forEach((part, partIndex) => validatePart(part, index, partIndex));
  const { content: _content, ...rest } = m;
  return { ...rest, parts } as unknown as UIMessage;
}

function validatePart(part: unknown, messageIndex: number, partIndex: number): void {
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    throw new Error(`message ${messageIndex} part ${partIndex} must be an object`);
  }
  const p = part as Record<string, unknown>;
  if (typeof p.type !== "string" || p.type.length === 0) {
    throw new Error(`message ${messageIndex} part ${partIndex} must have a type`);
  }
  if ((p.type === "text" || p.type === "reasoning") && typeof p.text !== "string") {
    throw new Error(`message ${messageIndex} part ${partIndex} must have text`);
  }
  if (p.type === "file" && (typeof p.url !== "string" || typeof p.mediaType !== "string")) {
    throw new Error(`message ${messageIndex} part ${partIndex} has invalid file data`);
  }
}

function collectText(value: unknown, chunks: string[]) {
  if (!Array.isArray(value)) return;
  for (const part of value) {
    if (!part || typeof part !== "object") continue;
    const obj = part as Record<string, unknown>;
    if ((obj.type === "text" || obj.type === "reasoning") && typeof obj.text === "string") {
      chunks.push(obj.text);
    }
  }
}

function threadContentToParts(value: unknown, index: number): Array<Record<string, unknown>> {
  if (typeof value === "string") {
    return value ? [{ type: "text", text: value }] : [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`message ${index} must have parts`);
  }
  return value.map((part, partIndex) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      throw new Error(`message ${index} content ${partIndex} must be an object`);
    }
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") {
      return { type: "text", text: p.text };
    }
    if (p.type === "reasoning" && typeof p.text === "string") {
      return { type: "reasoning", text: p.text };
    }
    if (p.type === "file" && typeof p.data === "string" && typeof p.mimeType === "string") {
      return {
        type: "file",
        url: p.data,
        mediaType: p.mimeType,
        filename: typeof p.filename === "string" ? p.filename : undefined,
      };
    }
    if (p.type === "image" && typeof p.image === "string") {
      return {
        type: "file",
        url: p.image,
        mediaType: "image/*",
        filename: typeof p.filename === "string" ? p.filename : undefined,
      };
    }
    return p;
  });
}

function partsToThreadContent(parts: UIMessage["parts"]): Array<Record<string, unknown>> {
  return parts.map((part) => {
    const p = part as unknown as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") {
      return { type: "text", text: p.text };
    }
    if (p.type === "reasoning" && typeof p.text === "string") {
      return { type: "reasoning", text: p.text };
    }
    if (p.type === "file" && typeof p.url === "string") {
      return {
        type: "file",
        data: p.url,
        mimeType: typeof p.mediaType === "string" ? p.mediaType : "application/octet-stream",
        filename: typeof p.filename === "string" ? p.filename : undefined,
      };
    }
    return p;
  });
}
