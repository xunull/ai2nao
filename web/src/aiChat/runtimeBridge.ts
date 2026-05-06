import type { UIMessage } from "ai";

let restoredBaseMessages: UIMessage[] = [];

export function setRestoredBaseMessages(messages: UIMessage[]) {
  restoredBaseMessages = messages;
}

export function clearRestoredBaseMessages() {
  restoredBaseMessages = [];
}

export function getRestoredBaseMessages() {
  return restoredBaseMessages;
}

export function mergeWithRestoredBase(messages: readonly unknown[]) {
  if (restoredBaseMessages.length === 0) return messages;
  const firstRuntimeId = (messages[0] as { id?: unknown } | undefined)?.id;
  if (typeof firstRuntimeId === "string" && restoredBaseMessages.some((message) => message.id === firstRuntimeId)) {
    return messages;
  }
  return [...restoredBaseMessages, ...messages];
}
