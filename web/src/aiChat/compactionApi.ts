/**
 * 压缩相关的三个写操作。
 *
 * **不用 `../api` 的 `apiPost`。** 压缩/撤销路由(`copilotRuntime.ts`)的错误体是
 * `{ error: "文案" }`(字符串),而 `apiPost` 只认 `{ error: { message } }` —— 用它的话,
 * 「这个会话正在生成回答」「撤销后上下文会超出模型窗口」这类可操作文案会被换成状态行
 * `Conflict`,规格要求的「撤销闸拒绝时显示原因」就落空了。两种形状这里都认。
 */
async function send<T>(method: "POST" | "PATCH", path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await r.json();
  } catch {
    /* 非 JSON 体:下面退回状态行 */
  }
  if (!r.ok) {
    const e = (json as { error?: unknown } | null)?.error;
    const msg =
      typeof e === "string"
        ? e
        : typeof (e as { message?: unknown } | undefined)?.message === "string"
          ? (e as { message: string }).message
          : r.statusText;
    throw new Error(msg || `HTTP ${r.status}`);
  }
  return json as T;
}

export function compactSession(sessionId: string, upToMessageIndex: number): Promise<unknown> {
  return send("POST", `/api/copilotkit/agent/default/compact/${encodeURIComponent(sessionId)}`, {
    upToMessageIndex,
  });
}

export function revertCompaction(sessionId: string, compactionId: string): Promise<unknown> {
  return send(
    "POST",
    `/api/copilotkit/agent/default/compaction/${encodeURIComponent(sessionId)}/undo`,
    { compactionId }
  );
}

export function setCompactionAuto(sessionId: string, auto: boolean): Promise<unknown> {
  return send(
    "PATCH",
    `/api/llm-chat/sessions/${encodeURIComponent(sessionId)}/compaction-settings`,
    { auto }
  );
}
