import { apiDelete, apiGet, apiPost } from "../api";
import type { AiChatSessionDetail, AiChatSessionSummary } from "./types";

type SessionsRes = { sessions: AiChatSessionSummary[] };
type SessionRes = { session: AiChatSessionDetail };
type CreateSessionRes = { session: AiChatSessionSummary };

type ApiOptions = { signal?: AbortSignal };

export async function listAiChatSessions(options?: ApiOptions): Promise<AiChatSessionSummary[]> {
  const res = await apiGet<SessionsRes>("/api/llm-chat/sessions?limit=50", options);
  return res.sessions;
}

export async function createAiChatSession(
  title?: string,
  options?: ApiOptions
): Promise<AiChatSessionSummary> {
  const res = await apiPost<CreateSessionRes>("/api/llm-chat/sessions", { title }, options);
  return res.session;
}

export async function getAiChatSession(
  id: string,
  options?: ApiOptions
): Promise<AiChatSessionDetail> {
  const res = await apiGet<SessionRes>(
    `/api/llm-chat/sessions/${encodeURIComponent(id)}`,
    options
  );
  return res.session;
}

export async function syncAiChatSession(
  id: string,
  messages: readonly unknown[],
  title?: string,
  options?: ApiOptions
): Promise<AiChatSessionDetail> {
  const res = await apiPost<SessionRes>(
    `/api/llm-chat/sessions/${encodeURIComponent(id)}/sync`,
    { title, messages },
    options
  );
  return res.session;
}

export async function deleteAiChatSession(id: string, options?: ApiOptions): Promise<void> {
  await apiDelete<{ ok: true }>(
    `/api/llm-chat/sessions/${encodeURIComponent(id)}`,
    options
  );
}
