import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { MessageMarkdown } from "../components/MessageMarkdown";
import { formatFileTimeMs } from "../util/formatDisplay";

const PAGE_SIZE = 50;

type Diagnostic = {
  kind: string;
  message: string;
  path?: string;
};

type Status = {
  platform: string;
  cherryRoot: string;
  agentsDbPath: string;
  indexedDbPath: string;
  exportRoot?: string;
  indexedDbAvailable: boolean;
  indexedDbMissing: boolean;
  indexedDbTopicCount: number | null;
  agentDbMissing: boolean;
  exportRootMissing: boolean;
  envCherryStudioExportRoot: boolean;
  warnings?: string[];
};

type SessionSummary = {
  id: string;
  index: number;
  title: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  messageCount: number;
  workspacePath?: string;
  preview?: string;
  source?: string;
};

type SessionsResponse = {
  ok: true;
  cherryRoot: string;
  agentsDbPath: string;
  indexedDbPath: string;
  indexedDbTopicCount: number;
  exportRoot?: string;
  diagnostics: Diagnostic[];
  scannedCount: number;
  truncated: boolean;
  total: number;
  limit: number;
  offset: number;
  sessions: SessionSummary[];
};

type SearchResponse = {
  ok: true;
  q: string;
  results: Array<{
    sessionId: string;
    index: number;
    workspacePath: string;
    createdAt: string;
    matchCount: number;
    snippets: Array<{ messageRole: string; text: string }>;
  }>;
};

type ApiMessage = {
  id: string | null;
  role: string;
  content: string;
  timestamp: string;
};

type SessionDetail = {
  id: string;
  title: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  messageCount: number;
  workspacePath?: string;
  source?: string;
  messages: ApiMessage[];
};

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    const value = String(v).trim();
    if (value !== "") p.set(k, value);
  }
  const q = p.toString();
  return q ? `?${q}` : "";
}

function asPage(raw: string | null): number {
  const page = parseInt(raw ?? "1", 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function roleLabel(role: string): string {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  return role;
}

const inputClass =
  "h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-800 shadow-sm transition placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900/10";

const btnGhost =
  "inline-flex h-8 items-center justify-center rounded-md border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-700 shadow-sm transition hover:border-neutral-300 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-45";

const btnDark =
  "inline-flex h-9 items-center justify-center rounded-md bg-neutral-950 px-3 text-sm font-medium text-white transition hover:bg-neutral-800";

export function CherryStudioHistory() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const routeParams = useParams<{ sessionId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const routeSessionId = routeParams.sessionId ?? "";
  const cherryRoot = searchParams.get("cherryRoot") ?? "";
  const exportRoot = searchParams.get("exportRoot") ?? "";
  const q = searchParams.get("q") ?? "";
  const page = asPage(searchParams.get("page"));
  const offset = (page - 1) * PAGE_SIZE;
  const selectedSessionId = routeSessionId || searchParams.get("sessionId") || "";
  const [draftCherryRoot, setDraftCherryRoot] = useState(cherryRoot);
  const [draftExportRoot, setDraftExportRoot] = useState(exportRoot);
  const [draftQ, setDraftQ] = useState(q);
  const [infoOpen, setInfoOpen] = useState(false);

  useEffect(() => setDraftCherryRoot(cherryRoot), [cherryRoot]);
  useEffect(() => setDraftExportRoot(exportRoot), [exportRoot]);
  useEffect(() => setDraftQ(q), [q]);

  const sourceSuffix = useMemo(() => qs({ cherryRoot, exportRoot }), [cherryRoot, exportRoot]);
  const listSuffix = useMemo(
    () => qs({ cherryRoot, exportRoot, limit: PAGE_SIZE, offset }),
    [cherryRoot, exportRoot, offset]
  );
  const searchSuffix = useMemo(
    () => qs({ cherryRoot, exportRoot, q }),
    [cherryRoot, exportRoot, q]
  );

  const status = useQuery({
    queryKey: ["cherry-studio-history-status", sourceSuffix],
    queryFn: () => apiGet<Status>(`/api/cherry-studio-history/status${sourceSuffix}`),
  });

  const sessions = useQuery({
    queryKey: ["cherry-studio-history-sessions", listSuffix],
    queryFn: () =>
      apiGet<SessionsResponse>(`/api/cherry-studio-history/sessions${listSuffix}`),
  });

  const search = useQuery({
    queryKey: ["cherry-studio-history-search", searchSuffix],
    queryFn: () =>
      apiGet<SearchResponse>(`/api/cherry-studio-history/search${searchSuffix}`),
    enabled: q.trim().length > 0,
  });

  const detailSuffix = useMemo(() => qs({ cherryRoot, exportRoot }), [cherryRoot, exportRoot]);
  const session = useQuery({
    queryKey: ["cherry-studio-history-session", selectedSessionId, detailSuffix],
    queryFn: () =>
      apiGet<{ ok: boolean; session: SessionDetail; warnings?: string[] }>(
        `/api/cherry-studio-history/sessions/${encodeURIComponent(selectedSessionId)}${detailSuffix}`
      ),
    enabled: selectedSessionId.length > 0,
  });

  const visibleDiagnostics = useMemo(() => {
    const configuredExportRoot = exportRoot.trim().length > 0 || status.data?.envCherryStudioExportRoot === true;
    return (sessions.data?.diagnostics ?? []).filter(
      (d) => d.kind !== "exportRootMissing" || configuredExportRoot
    );
  }, [exportRoot, sessions.data?.diagnostics, status.data?.envCherryStudioExportRoot]);

  useEffect(() => {
    if (selectedSessionId) return;
    const firstSearchId = q.trim() ? search.data?.results[0]?.sessionId : undefined;
    const firstListId = sessions.data?.sessions[0]?.id;
    const nextId = firstSearchId ?? firstListId;
    if (!nextId) return;
    updateUrl({ sessionId: nextId }, true);
  }, [q, search.data?.results, selectedSessionId, sessions.data?.sessions]);

  function updateUrl(updates: Record<string, string | number | undefined>, replace = false) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value == null || String(value).trim() === "") next.delete(key);
      else next.set(key, String(value));
    }
    navigate(`/cherry-studio-history${next.toString() ? `?${next.toString()}` : ""}`, {
      replace: replace || Boolean(routeSessionId),
    });
  }

  function applyFilters(e: FormEvent) {
    e.preventDefault();
    const next = new URLSearchParams();
    if (draftCherryRoot.trim()) next.set("cherryRoot", draftCherryRoot.trim());
    if (draftExportRoot.trim()) next.set("exportRoot", draftExportRoot.trim());
    if (draftQ.trim()) next.set("q", draftQ.trim());
    next.set("page", "1");
    setSearchParams(next, { replace: true });
    setInfoOpen(false);
  }

  function refreshAll() {
    void queryClient.invalidateQueries({ queryKey: ["cherry-studio-history-status"] });
    void queryClient.invalidateQueries({ queryKey: ["cherry-studio-history-sessions"] });
    void queryClient.invalidateQueries({ queryKey: ["cherry-studio-history-search"] });
    void queryClient.invalidateQueries({ queryKey: ["cherry-studio-history-session"] });
  }

  function pickSession(id: string) {
    updateUrl({ sessionId: id });
  }

  function goToPage(nextPage: number) {
    updateUrl({ page: Math.max(1, nextPage), sessionId: undefined });
  }

  const total = sessions.data?.total ?? 0;
  const rows = sessions.data?.sessions.length ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + rows;
  const hasPrevious = page > 1;
  const hasNext = sessions.data ? offset + rows < sessions.data.total : false;
  const searchMode = q.trim().length > 0;

  return (
    <div className="cursor-chat-root -mx-1 h-[calc(100vh-112px)] min-h-[720px] overflow-hidden rounded-xl border border-neutral-200 bg-[#f7f7f4]">
      <div className="grid h-full grid-cols-[350px_minmax(0,1fr)]">
        <aside className="flex h-full min-h-0 flex-col border-r border-neutral-200 bg-white">
          <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-4 py-3 text-xs text-neutral-500">
            {searchMode ? (
              <span>
                搜索结果 {search.data?.results.length ?? 0} 条
              </span>
            ) : (
              <span>
                第 {from}-{to} 条，共 {total} 条
              </span>
            )}
            {!searchMode && (
              <div className="flex gap-1">
                <button
                  type="button"
                  className={btnGhost}
                  disabled={!hasPrevious || sessions.isFetching}
                  onClick={() => goToPage(page - 1)}
                >
                  上一页
                </button>
                <button
                  type="button"
                  className={btnGhost}
                  disabled={!hasNext || sessions.isFetching}
                  onClick={() => goToPage(page + 1)}
                >
                  下一页
                </button>
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3" data-testid="cherry-session-rail">
            {sessions.isLoading || (searchMode && search.isLoading) ? (
              <p className="px-3 py-2 text-sm text-neutral-500">加载会话中...</p>
            ) : sessions.isError || search.isError ? (
              <p className="px-3 py-2 text-sm text-red-600">
                {((sessions.error ?? search.error) as Error).message}
              </p>
            ) : searchMode ? (
              <SearchRail
                results={search.data?.results ?? []}
                selectedSessionId={selectedSessionId}
                onPick={pickSession}
              />
            ) : (
              <SessionRail
                sessions={sessions.data?.sessions ?? []}
                selectedSessionId={selectedSessionId}
                onPick={pickSession}
              />
            )}
          </div>
        </aside>

        <main className="flex h-full min-h-0 flex-col">
          <header className="flex h-14 items-center justify-between gap-4 border-b border-neutral-200 bg-white/80 px-5">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-neutral-950">
                {session.data?.session.title?.trim() || "选择 Cherry 对话"}
              </h2>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600">
                只读
              </span>
              <button type="button" className={btnGhost} onClick={() => setInfoOpen(true)}>
                信息
              </button>
            </div>
          </header>

          <section className="min-h-0 flex-1 p-4" data-testid="cherry-readonly-thread-shell">
            <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
              {!selectedSessionId ? (
                <EmptyState text="请选择左侧对话" />
              ) : session.isLoading ? (
                <EmptyState text="加载对话中..." />
              ) : session.isError ? (
                <div className="m-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
                  {(session.error as Error).message}
                </div>
              ) : session.data ? (
                <Transcript session={session.data.session} warnings={session.data.warnings ?? []} />
              ) : (
                <EmptyState text="请选择左侧对话" />
              )}
            </div>
          </section>
        </main>
      </div>
      {infoOpen && (
        <CherryInfoModal
          status={status.data}
          sessions={sessions.data}
          currentSession={session.data?.session}
          diagnostics={visibleDiagnostics}
          draftCherryRoot={draftCherryRoot}
          draftExportRoot={draftExportRoot}
          draftQ={draftQ}
          onCherryRootChange={setDraftCherryRoot}
          onExportRootChange={setDraftExportRoot}
          onQChange={setDraftQ}
          onApply={applyFilters}
          onRefresh={refreshAll}
          onClose={() => setInfoOpen(false)}
        />
      )}
    </div>
  );
}

function CherryInfoModal({
  status,
  sessions,
  currentSession,
  diagnostics,
  draftCherryRoot,
  draftExportRoot,
  draftQ,
  onCherryRootChange,
  onExportRootChange,
  onQChange,
  onApply,
  onRefresh,
  onClose,
}: {
  status?: Status;
  sessions?: SessionsResponse;
  currentSession?: SessionDetail;
  diagnostics: Diagnostic[];
  draftCherryRoot: string;
  draftExportRoot: string;
  draftQ: string;
  onCherryRootChange: (value: string) => void;
  onExportRootChange: (value: string) => void;
  onQChange: (value: string) => void;
  onApply: (event: FormEvent) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 px-6 py-16" role="dialog" aria-modal="true" aria-labelledby="cherry-info-title">
      <div className="w-[640px] max-w-full overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-neutral-200 px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-400">
              Cherry Studio
            </p>
            <h2 id="cherry-info-title" className="mt-1 text-lg font-semibold text-neutral-950">
              Cherry 对话信息
            </h2>
          </div>
          <button type="button" className={btnGhost} onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-wrap gap-2 text-xs">
            <span
              className={[
                "rounded-full border px-2.5 py-1 font-medium",
                status?.indexedDbAvailable
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-amber-200 bg-amber-50 text-amber-900",
              ].join(" ")}
            >
              IndexedDB {status?.indexedDbTopicCount ?? sessions?.indexedDbTopicCount ?? 0} topics
            </span>
            {sessions && (
              <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-1 font-medium text-neutral-600">
                共 {sessions.total} 个会话
              </span>
            )}
          </div>

          {currentSession && (
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-3 text-xs text-neutral-600">
              <div className="truncate text-sm font-semibold text-neutral-900">
                {currentSession.title?.trim() || "无标题会话"}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                <span>{currentSession.messageCount} 条消息</span>
                <span>更新 {formatFileTimeMs(new Date(currentSession.lastUpdatedAt).getTime())}</span>
                <span>{currentSession.source === "cherry-studio" ? "Cherry Studio" : currentSession.source ?? "未知来源"}</span>
              </div>
            </div>
          )}

          {status?.indexedDbMissing && (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
              未找到 Cherry Studio IndexedDB，会继续尝试 Agent 与 Markdown 导出来源。
            </p>
          )}

          {diagnostics.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
              {diagnostics.slice(0, 4).map((d) => (
                <div key={`${d.kind}-${d.path ?? d.message}`}>
                  <span className="font-semibold">{d.kind}</span>
                  <span className="ml-1">{d.message}</span>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={onApply} className="space-y-3">
            <input
              className={inputClass}
              value={draftQ}
              onChange={(e) => onQChange(e.target.value)}
              placeholder="搜索 Cherry 对话"
            />
            <input
              className={`${inputClass} font-mono text-xs`}
              value={draftCherryRoot}
              onChange={(e) => onCherryRootChange(e.target.value)}
              placeholder="Cherry root"
            />
            <input
              className={`${inputClass} font-mono text-xs`}
              value={draftExportRoot}
              onChange={(e) => onExportRootChange(e.target.value)}
              placeholder="Markdown export root（可选）"
            />
            <div className="flex justify-between gap-3 pt-1">
              <button type="button" className={btnGhost} onClick={onRefresh}>
                刷新
              </button>
              <button type="submit" className={btnDark}>
                应用
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

function SessionRail({
  sessions,
  selectedSessionId,
  onPick,
}: {
  sessions: SessionSummary[];
  selectedSessionId: string;
  onPick: (id: string) => void;
}) {
  if (sessions.length === 0) {
    return <p className="px-3 py-2 text-sm text-neutral-500">暂无可展示的 Cherry Studio 对话。</p>;
  }
  return (
    <ul className="space-y-1">
      {sessions.map((session) => {
        const active = session.id === selectedSessionId;
        return (
          <li key={session.id}>
            <button
              type="button"
              onClick={() => onPick(session.id)}
              className={[
                "block w-full rounded-lg border px-3 py-2 text-left transition",
                active
                  ? "border-neutral-900 bg-neutral-950 text-white"
                  : "border-transparent bg-white text-neutral-800 hover:border-neutral-200 hover:bg-neutral-50",
              ].join(" ")}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium">
                  {session.title?.trim() || "无标题会话"}
                </span>
                <span className={active ? "shrink-0 text-xs text-neutral-300" : "shrink-0 text-xs text-neutral-400"}>
                  #{session.index}
                </span>
              </div>
              <div className={active ? "mt-1 text-xs text-neutral-300" : "mt-1 text-xs text-neutral-500"}>
                {session.messageCount} 条 · {formatFileTimeMs(new Date(session.lastUpdatedAt).getTime())}
              </div>
              {session.preview && (
                <p className={active ? "mt-2 line-clamp-2 text-xs text-neutral-300" : "mt-2 line-clamp-2 text-xs text-neutral-500"}>
                  {session.preview}
                </p>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function SearchRail({
  results,
  selectedSessionId,
  onPick,
}: {
  results: SearchResponse["results"];
  selectedSessionId: string;
  onPick: (id: string) => void;
}) {
  if (results.length === 0) {
    return <p className="px-3 py-2 text-sm text-neutral-500">没有命中。</p>;
  }
  return (
    <ul className="space-y-1">
      {results.map((result) => {
        const active = result.sessionId === selectedSessionId;
        return (
          <li key={result.sessionId}>
            <button
              type="button"
              onClick={() => onPick(result.sessionId)}
              className={[
                "block w-full rounded-lg border px-3 py-2 text-left transition",
                active
                  ? "border-neutral-900 bg-neutral-950 text-white"
                  : "border-transparent bg-white text-neutral-800 hover:border-neutral-200 hover:bg-neutral-50",
              ].join(" ")}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">搜索结果 #{result.index}</span>
                <span className={active ? "text-xs text-neutral-300" : "text-xs text-neutral-400"}>
                  {result.matchCount} 处
                </span>
              </div>
              <p className={active ? "mt-2 line-clamp-2 text-xs text-neutral-300" : "mt-2 line-clamp-2 text-xs text-neutral-500"}>
                {result.snippets[0]?.text ?? result.workspacePath}
              </p>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Transcript({ session, warnings }: { session: SessionDetail; warnings: string[] }) {
  return (
    <>
      {(warnings.length > 0 || session.workspacePath) && (
        <div className="border-b border-neutral-100 bg-slate-50 px-4 py-3 text-xs text-neutral-600">
          {session.workspacePath && (
            <div className="break-all font-mono">{session.workspacePath}</div>
          )}
          {warnings.length > 0 && (
            <div className="mt-1 text-amber-800">{warnings.join(" · ")}</div>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {session.messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            此会话没有可展示的消息
          </div>
        ) : (
          <div className="mx-auto max-w-4xl space-y-5 pb-8">
            {session.messages.map((message, idx) => {
              const isUser = message.role === "user";
              return (
                <article
                  key={message.id ?? `m-${idx}`}
                  className={[
                    "rounded-lg px-4 py-4 shadow-sm",
                    isUser
                      ? "ml-auto max-w-[76%] border border-slate-200 bg-slate-100"
                      : "mr-auto max-w-[88%] border border-neutral-100 bg-white ring-1 ring-black/[0.04]",
                  ].join(" ")}
                >
                  <header className="mb-3 flex items-center gap-2">
                    <span
                      className={[
                        "rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase",
                        isUser ? "bg-blue-100 text-blue-800" : "bg-emerald-50 text-emerald-800",
                      ].join(" ")}
                    >
                      {roleLabel(message.role)}
                    </span>
                    <span className="text-xs tabular-nums text-neutral-400">
                      {formatFileTimeMs(new Date(message.timestamp).getTime())}
                    </span>
                  </header>
                  <MessageMarkdown text={message.content} />
                </article>
              );
            })}
          </div>
        )}
      </div>
      <div className="border-t border-neutral-100 bg-slate-50 px-4 py-3 text-xs text-neutral-500">
        只读历史视图，没有输入框或发送操作。
      </div>
    </>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-neutral-300 bg-white text-sm text-neutral-600">
      {text}
    </div>
  );
}
