import { apiDelete, apiGet, apiPost } from "../api";
import type {
  AiChatOriginalPage,
  AiChatSessionDetail,
  AiChatSessionSummary,
  AiChatSessionUsage,
} from "./types";

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

/**
 * 会话用量聚合。一轮结束、压缩或撤销之后都要重取 —— `context` 与 `compactions`
 * 都会随之变化。
 */
export async function getAiChatSessionUsage(
  id: string,
  options?: ApiOptions
): Promise<AiChatSessionUsage> {
  const res = await apiGet<{ usage: AiChatSessionUsage }>(
    `/api/llm-chat/sessions/${encodeURIComponent(id)}/usage`,
    options
  );
  return res.usage;
}

/**
 * 分页读取原文(**含被压缩掉的轮次**)。压缩只是不再发给模型,原文一条不少。
 *
 * `before` 传上一页返回的 `nextBefore`;拿到 `nextBefore === null` 就是到底了。
 */
export async function getAiChatSessionMessages(
  id: string,
  params?: { before?: number | null; limit?: number },
  options?: ApiOptions
): Promise<AiChatOriginalPage> {
  const qs = new URLSearchParams();
  if (params?.before != null) qs.set("before", String(params.before));
  if (params?.limit != null) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiGet<AiChatOriginalPage>(
    `/api/llm-chat/sessions/${encodeURIComponent(id)}/messages${suffix}`,
    options
  );
}

export async function deleteAiChatSession(id: string, options?: ApiOptions): Promise<void> {
  await apiDelete<{ ok: true }>(
    `/api/llm-chat/sessions/${encodeURIComponent(id)}`,
    options
  );
}
