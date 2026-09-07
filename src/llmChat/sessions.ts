import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Message } from "@ag-ui/client";
import { putBlob, sniffImageMime } from "../blobStore.js";

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
  // **抽取必须在 stringify 之前。** 落库的是抽取后的形状,而 1.5 MB 上限
  // (MAX_SYNC_RAW_BYTES)是在本函数返回之后按 raw_json 长度累加的 —— 顺序对了,
  // 那道闸看到的就已经是短引用而不是 base64。
  const extracted = extractInlineImages(msg, index);
  const rawJson = JSON.stringify(extracted);
  // 存库这一路要的是「这条消息有没有内容」,纯图消息必须算有;
  // 发给模型那一路要的是纯文本,两者语义相反,所以是两个函数。
  const plainText = previewTextFromAgUiMessage(extracted);
  const preview = previewForAgUiMessage(extracted, plainText);
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

/** 单条消息最多几张图。多图横向对比是真实用法,但没有理由一次几十张。 */
const MAX_IMAGES_PER_MESSAGE = 6;
/** 解码**之后**的字节上限。前端的 maxSize 是浏览器提示,不是边界。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 唯一允许的 url 源前缀 —— 我们自己的 blob 出口。 */
const BLOB_URL_PREFIX = "/api/blobs/";

type MediaSource = { type?: unknown; value?: unknown; mimeType?: unknown };
type MediaPart = { type?: unknown; source?: MediaSource; metadata?: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * 把消息里内联的图片抽进 blob 仓,正文换成 `/api/blobs/<sha>` 引用。
 *
 * **为什么必须在服务端做,而不是靠前端的 `onUpload`:** CopilotKit 的
 * `useAttachments` 里,`onUpload` 缺席时走的是
 * `source = { type: "data", value: await readFileAsBase64(file), mimeType }`,
 * 默认 `maxSize` 是 20 MB。也就是说前端一个配置失误,整个文件就 base64 进了消息。
 * 服务端不设防的话,后果是**模型已答完、钱已花完**之后落库才 413(那一行在 try 内)。
 *
 * **不要用 `parseDataUri`。** 它的第一行是 `startsWith("data:")`,而
 * `readFileAsBase64` 的文档注释写着 "string (without the data URL prefix)",
 * 实现是 `result.split(",")[1]` —— 拿到的是**裸 base64**。喂给 parseDataUri
 * 只会静默返回 null,抽取什么都不做,图永远内联。
 *
 * **写失败就不剥**(照抄 `slimPartData` 已验证的语义):宁可继续内联占地方,
 * 也不能出现「正文剥了、blob 没写成」那种两头落空的行。
 */
function extractInlineImages(msg: Message & { role: string }, index: number): Message {
  const content = "content" in msg ? msg.content : undefined;
  if (!Array.isArray(content)) return msg;

  let imageCount = 0;
  let changed = false;
  const out = content.map((part) => {
    if (!isRecord(part)) return part;
    const p = part as MediaPart;
    const kind = typeof p.type === "string" ? p.type : "";
    if (kind === "text") return part;

    // 只支持图片。音频/视频/文档没有任何一条下游路径能处理,留着只会撑爆载荷。
    if (kind === "audio" || kind === "video" || kind === "document" || kind === "binary") {
      throw new LlmChatSessionError(
        400,
        `message at index ${index}: 暂不支持 ${kind} 附件，目前只支持图片`
      );
    }
    if (kind !== "image") return part;

    imageCount += 1;
    if (imageCount > MAX_IMAGES_PER_MESSAGE) {
      throw new LlmChatSessionError(
        400,
        `message at index ${index}: 一条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图`
      );
    }

    const src = isRecord(p.source) ? (p.source as MediaSource) : null;
    if (!src) return part;

    // url 源:只认我们自己的 blob 出口。外部 URL 直接拒绝,**且绝不去取** ——
    // 本机应用能看见内网,替调用方发出站请求就是 SSRF。
    if (src.type === "url") {
      const value = typeof src.value === "string" ? src.value : "";
      if (!value.startsWith(BLOB_URL_PREFIX)) {
        throw new LlmChatSessionError(
          400,
          `message at index ${index}: 图片只能引用本机附件仓，不接受外部地址`
        );
      }
      return part;
    }

    if (src.type !== "data") return part;
    const b64 = typeof src.value === "string" ? src.value : "";
    if (!b64) return part;

    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64, "base64");
    } catch {
      throw new LlmChatSessionError(400, `message at index ${index}: 图片数据无法解码`);
    }
    if (bytes.length === 0) {
      throw new LlmChatSessionError(400, `message at index ${index}: 图片数据无法解码`);
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new LlmChatSessionError(
        413,
        `message at index ${index}: 单张图片超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MB`
      );
    }

    // 真实魔术字节必须与声明的 mime 对得上。对不上就是坏数据或伪装,
    // 白花一次钱换一个看不懂的报错不如当场拒。
    const sniffed = sniffImageMime(bytes);
    if (!sniffed) {
      throw new LlmChatSessionError(
        400,
        `message at index ${index}: 只支持 PNG / JPEG / WebP / GIF`
      );
    }
    const declared = typeof src.mimeType === "string" ? src.mimeType : "";
    if (declared && declared !== sniffed) {
      throw new LlmChatSessionError(
        400,
        `message at index ${index}: 图片实际类型是 ${sniffed}，与声明的 ${declared} 不符`
      );
    }

    const ref = putBlob(bytes, sniffed);
    if (!ref) return part; // 写不成就不剥 —— 绝不两头落空
    changed = true;
    return {
      ...part,
      source: { type: "url", value: `${BLOB_URL_PREFIX}${ref.sha256}`, mimeType: sniffed },
      metadata: {
        ...(isRecord(p.metadata) ? p.metadata : {}),
        sha256: ref.sha256,
        bytes: ref.bytes,
      },
    };
  });

  return changed ? ({ ...msg, content: out } as Message) : msg;
}

/**
 * 给**存库**用的文本:图片折成「[图片]」占位。
 *
 * 与 `textFromAgUiMessage` 分家,因为两个调用方要的东西相反 —— 存库要一个占位
 * 字符串好让预览、标题、`message_count` 都成立;发给模型要真正的 image part,
 * 收到字符串「[图片]」等于把占位符当正文发出去。
 * 合成一个函数正是「纯图消息被整条丢弃」那个 bug 的成因。
 */
export function previewTextFromAgUiMessage(message: Message): string {
  const content = "content" in message ? message.content : "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part.type === "text") return typeof part.text === "string" ? part.text : "";
      if (part.type === "image") return "[图片]";
      return "";
    })
    .join("");
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
