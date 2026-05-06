import type { UIMessage } from "ai";

export class LlmChatMessageCodecError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function validateLlmChatUiMessages(value: unknown): UIMessage[] {
  if (!Array.isArray(value)) {
    throw new LlmChatMessageCodecError("messages must be an array");
  }
  return value.map((message, index) => validateLlmChatUiMessage(message, index));
}

export function validateLlmChatUiMessage(value: unknown, index = 0): UIMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LlmChatMessageCodecError(`message ${index} must be an object`);
  }

  const message = value as Record<string, unknown>;
  if (typeof message.id !== "string" || message.id.trim().length === 0) {
    throw new LlmChatMessageCodecError(`message ${index} must have an id`);
  }
  if (
    message.role !== "system" &&
    message.role !== "user" &&
    message.role !== "assistant"
  ) {
    throw new LlmChatMessageCodecError(`message ${index} has invalid role`);
  }
  if (!Array.isArray(message.parts)) {
    throw new LlmChatMessageCodecError(`message ${index} must have parts`);
  }
  message.parts.forEach((part, partIndex) =>
    validateUiMessagePart(part, index, partIndex)
  );

  return message as unknown as UIMessage;
}

export function textFromUiMessage(message: UIMessage): string {
  const chunks: string[] = [];
  collectTextParts(message.parts, chunks);
  return chunks.join("\n").trim();
}

function validateUiMessagePart(part: unknown, messageIndex: number, partIndex: number): void {
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    throw new LlmChatMessageCodecError(
      `message ${messageIndex} part ${partIndex} must be an object`
    );
  }
  const p = part as Record<string, unknown>;
  if (typeof p.type !== "string" || p.type.length === 0) {
    throw new LlmChatMessageCodecError(
      `message ${messageIndex} part ${partIndex} must have a type`
    );
  }
  if ((p.type === "text" || p.type === "reasoning") && typeof p.text !== "string") {
    throw new LlmChatMessageCodecError(
      `message ${messageIndex} part ${partIndex} must have text`
    );
  }
  if (p.type === "file" && (typeof p.url !== "string" || typeof p.mediaType !== "string")) {
    throw new LlmChatMessageCodecError(
      `message ${messageIndex} part ${partIndex} has invalid file data`
    );
  }
}

function collectTextParts(value: unknown, chunks: string[]): void {
  if (!Array.isArray(value)) return;
  for (const part of value) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if ((p.type === "text" || p.type === "reasoning") && typeof p.text === "string") {
      chunks.push(p.text);
    }
  }
}
