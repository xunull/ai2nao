import { CopilotChat, CopilotKit } from "@copilotkit/react-core/v2";
import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../api";
import {
  createAiChatSession,
  deleteAiChatSession,
  listAiChatSessions,
} from "../aiChat/sessionApi";
import type {
  AiChatSessionSummary,
  LlmChatStatus,
  RagStatus,
  WebSearchStatus,
} from "../aiChat/types";

function StatusPill({ label, tone }: { label: string; tone: "ok" | "warn" | "idle" }) {
  const cls =
    tone === "ok"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : tone === "warn"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-neutral-200 bg-white text-neutral-600";
  return (
    <span className={`rounded-full border px-3 py-1 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

function formatSessionTime(value: string | null): string {
  if (!value) return "尚无消息";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function AiChat() {
  const [cfg, setCfg] = useState<LlmChatStatus | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [rag, setRag] = useState<RagStatus | null>(null);
  const [ragErr, setRagErr] = useState<string | null>(null);
  const [useRag, setUseRag] = useState(false);
  const [webSearch, setWebSearch] = useState<WebSearchStatus | null>(null);
  const [webSearchErr, setWebSearchErr] = useState<string | null>(null);
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [sessions, setSessions] = useState<AiChatSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionErr, setSessionErr] = useState<string | null>(null);
  const [chatErr, setChatErr] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(true);

  const refreshSessions = useCallback(async (signal?: AbortSignal) => {
    const rows = await listAiChatSessions({ signal });
    setSessions(rows);
    return rows;
  }, []);

  const createAndSelect = useCallback(async () => {
    const session = await createAiChatSession();
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setSessionErr(null);
    setChatErr(null);
  }, []);

  const deleteAndSelectNext = useCallback(
    async (sessionId: string) => {
      await deleteAiChatSession(sessionId);
      const next = sessions.filter((s) => s.id !== sessionId);
      setSessions(next);
      if (activeSessionId === sessionId) {
        setActiveSessionId(next[0]?.id ?? null);
        if (!next[0]) await createAndSelect();
      }
    },
    [activeSessionId, createAndSelect, sessions]
  );

  const handleChatError = useCallback((event: unknown) => {
    const maybeRecord =
      event && typeof event === "object" ? (event as Record<string, unknown>) : {};
    const rawError = maybeRecord.error;
    const message =
      rawError instanceof Error
        ? rawError.message
        : typeof rawError === "string"
          ? rawError
          : typeof maybeRecord.message === "string"
            ? maybeRecord.message
            : "AI 对话请求失败，请检查后端服务和模型配置。";
    setChatErr(message);
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    apiGet<LlmChatStatus>("/api/llm-chat/status", { signal: ac.signal })
      .then((s) => {
        setCfg(s);
        setCfgErr(null);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setCfgErr(e instanceof Error ? e.message : String(e));
      });
    apiGet<RagStatus>("/api/rag/status", { signal: ac.signal })
      .then((s) => {
        setRag(s);
        setRagErr(null);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setRagErr(e instanceof Error ? e.message : String(e));
      });
    apiGet<WebSearchStatus>("/api/web-search/status", { signal: ac.signal })
      .then((s) => {
        setWebSearch(s);
        setWebSearchErr(null);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setWebSearchErr(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    setLoadingSessions(true);
    refreshSessions(ac.signal)
      .then(async (rows) => {
        if (ac.signal.aborted) return;
        if (rows[0]) {
          setActiveSessionId(rows[0].id);
        } else {
          await createAndSelect();
        }
        setSessionErr(null);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setSessionErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoadingSessions(false);
      });
    return () => ac.abort();
  }, [createAndSelect, refreshSessions]);

  const disabled = cfg?.configured !== true;
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const webSearchAvailable = webSearch?.ok === true;
  const effectiveWebSearch = useWebSearch && webSearchAvailable;

  return (
    <div className="cursor-chat-root -mx-1 h-[calc(100vh-112px)] min-h-[720px] overflow-hidden rounded-xl border border-neutral-200 bg-[#f7f7f4]">
      <link rel="stylesheet" href="/vendor/copilotkit-v2.css" />
      <div className="grid h-full grid-cols-[300px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-neutral-200 bg-white">
          <div className="border-b border-neutral-200 px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-400">
                  AI Studio
                </p>
                <h1 className="mt-1 text-xl font-semibold tracking-tight text-neutral-950">
                  AI 对话
                </h1>
              </div>
              <button
                type="button"
                onClick={() => void createAndSelect()}
                className="h-9 rounded-md bg-neutral-950 px-3 text-sm font-medium text-white hover:bg-neutral-800"
              >
                新对话
              </button>
            </div>
            {sessionErr ? (
              <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
                {sessionErr}
              </p>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3" data-testid="ai-chat-session-rail">
            {loadingSessions ? (
              <p className="px-3 py-2 text-sm text-neutral-500">加载会话中...</p>
            ) : sessions.length === 0 ? (
              <p className="px-3 py-2 text-sm text-neutral-500">还没有会话</p>
            ) : (
              sessions.map((session) => {
                const active = session.id === activeSessionId;
                return (
                  <div
                    key={session.id}
                    className={`group mb-1 flex items-center gap-2 rounded-lg border px-3 py-2 ${
                      active
                        ? "border-neutral-900 bg-neutral-950 text-white"
                        : "border-transparent bg-white text-neutral-800 hover:border-neutral-200 hover:bg-neutral-50"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setActiveSessionId(session.id);
                        setChatErr(null);
                      }}
                      className="min-w-0 flex-1 text-left"
                      data-testid="ai-chat-session"
                    >
                      <div className="truncate text-sm font-medium">{session.title}</div>
                      <div className={`mt-1 text-xs ${active ? "text-neutral-300" : "text-neutral-500"}`}>
                        {formatSessionTime(session.last_message_at)}
                      </div>
                    </button>
                    <button
                      type="button"
                      aria-label="删除对话"
                      onClick={() => void deleteAndSelectNext(session.id)}
                      className={`rounded px-2 py-1 text-xs ${
                        active ? "text-neutral-300 hover:bg-white/10" : "text-neutral-400 hover:bg-neutral-100"
                      }`}
                    >
                      删除
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        <main className="flex min-h-0 flex-col">
          <header className="flex items-center justify-between gap-4 border-b border-neutral-200 bg-white/80 px-5 py-4">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-neutral-950">
                {activeSession?.title ?? "新对话"}
              </h2>
              <p className="mt-1 text-sm text-neutral-500">
                每个历史会话独立保存到本机 SQLite，模型与工具流程由 ai2nao 后端掌控。
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <StatusPill
                label={cfg?.configured ? `模型 ${cfg.model}` : cfgErr ?? "模型未配置"}
                tone={cfg?.configured ? "ok" : "warn"}
              />
              <StatusPill
                label={rag?.ok ? `RAG ${rag.chunkCount} chunks` : ragErr ?? "RAG 不可用"}
                tone={rag?.ok ? "ok" : "idle"}
              />
              <StatusPill
                label={
                  webSearch?.ok
                    ? `Web ${webSearch.provider}`
                    : webSearch?.error ?? webSearchErr ?? "Web 未配置"
                }
                tone={webSearch?.ok ? "ok" : "idle"}
              />
              <label className="flex h-8 items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-700">
                <input
                  type="checkbox"
                  checked={useRag}
                  onChange={(e) => setUseRag(e.currentTarget.checked)}
                  className="h-3.5 w-3.5"
                />
                RAG
              </label>
              <label className={`flex h-8 items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 text-xs font-medium ${
                webSearchAvailable ? "text-neutral-700" : "text-neutral-400"
              }`}>
                <input
                  type="checkbox"
                  checked={useWebSearch}
                  disabled={!webSearchAvailable}
                  onChange={(e) => setUseWebSearch(e.currentTarget.checked)}
                  className="h-3.5 w-3.5"
                />
                Web Search
              </label>
            </div>
          </header>

          <section className="min-h-0 flex-1 p-4" data-testid="ai-chat-thread-shell">
            {disabled ? (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-neutral-300 bg-white text-sm text-neutral-600">
                请先配置本机 LLM，再开始对话。
              </div>
            ) : activeSessionId ? (
              <CopilotKit
                runtimeUrl="/api/copilotkit"
                useSingleEndpoint={true}
                properties={{ useRag, ragTopK: 8, webSearchEnabled: effectiveWebSearch }}
                onError={handleChatError}
                showDevConsole={false}
              >
                <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm [&_.copilotKitChat]:h-full">
                  {chatErr ? (
                    <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
                      {chatErr}
                    </div>
                  ) : null}
                  <CopilotChat
                    key={activeSessionId}
                    threadId={activeSessionId}
                    onError={handleChatError}
                    labels={{
                      modalHeaderTitle: "AI 对话",
                      welcomeMessageText: "开始新的本机 AI 对话",
                      chatInputPlaceholder: "输入消息，按 Enter 发送",
                    }}
                  />
                </div>
              </CopilotKit>
            ) : (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-neutral-300 bg-white text-sm text-neutral-600">
                正在准备新对话...
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
