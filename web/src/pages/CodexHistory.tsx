import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { formatFileTimeMs } from "../util/formatDisplay";

type Diagnostic = {
  kind: string;
  message: string;
  path?: string;
  count?: number;
};

type Status = {
  platform: string;
  codexRoot: string;
  sessionsRoot: string;
  stateDbPath: string;
  envCodexHome: boolean;
};

type CodexMetadata = {
  codex?: {
    cwd?: string;
    gitBranch?: string;
    model?: string;
    archived?: boolean;
    rolloutPath?: string;
    degraded?: boolean;
    degradationReason?: string;
    metrics?: {
      toolCallCount: number;
      commandCount: number;
      failedCommandCount: number;
      fileCount: number;
    };
  };
};

type SessionSummary = {
  id: string;
  index: number;
  title: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  messageCount: number;
  workspaceId: string;
  workspacePath?: string;
  preview?: string;
  metadata?: CodexMetadata;
};

type SessionsResponse = {
  ok: true;
  source: "sqlite" | "fallback";
  codexRoot: string;
  sessionsRoot: string;
  stateDbPath: string;
  diagnostics: Diagnostic[];
  scannedCount: number;
  truncated: boolean;
  sessions: SessionSummary[];
};

function enc(s: string): string {
  return encodeURIComponent(s);
}

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v.trim() !== "") p.set(k, v.trim());
  }
  const q = p.toString();
  return q ? `?${q}` : "";
}

const inputClass =
  "w-full rounded-xl border border-neutral-200 bg-white px-3.5 py-2.5 text-sm text-neutral-800 shadow-sm transition placeholder:text-neutral-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20";

const btnPrimary =
  "inline-flex items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500/40 active:scale-[0.98]";

const btnGhost =
  "inline-flex items-center justify-center rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm transition hover:border-blue-200 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500/20";

export function CodexHistory() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const codexRoot = searchParams.get("codexRoot") ?? "";
  const cwd = searchParams.get("cwd") ?? "";
  const gitBranch = searchParams.get("gitBranch") ?? "";
  const model = searchParams.get("model") ?? "";
  const includeArchived = searchParams.get("archived") === "true";
  const [draftRoot, setDraftRoot] = useState(codexRoot);
  const [draftCwd, setDraftCwd] = useState(cwd);
  const [draftBranch, setDraftBranch] = useState(gitBranch);
  const [draftModel, setDraftModel] = useState(model);

  useEffect(() => setDraftRoot(codexRoot), [codexRoot]);
  useEffect(() => setDraftCwd(cwd), [cwd]);
  useEffect(() => setDraftBranch(gitBranch), [gitBranch]);
  useEffect(() => setDraftModel(model), [model]);

  const apiSuffix = useMemo(
    () =>
      qs({
        codexRoot,
        cwd,
        gitBranch,
        model,
        archived: includeArchived ? "true" : "false",
      }),
    [codexRoot, cwd, gitBranch, model, includeArchived]
  );

  const status = useQuery({
    queryKey: ["codex-history-status", codexRoot],
    queryFn: () => apiGet<Status>(`/api/codex-history/status${qs({ codexRoot })}`),
  });

  const sessions = useQuery({
    queryKey: ["codex-history-sessions", apiSuffix],
    queryFn: () =>
      apiGet<SessionsResponse>(`/api/codex-history/sessions${apiSuffix}`),
  });

  function applyFilters(e: FormEvent) {
    e.preventDefault();
    const next = new URLSearchParams();
    if (draftRoot.trim()) next.set("codexRoot", draftRoot.trim());
    if (draftCwd.trim()) next.set("cwd", draftCwd.trim());
    if (draftBranch.trim()) next.set("gitBranch", draftBranch.trim());
    if (draftModel.trim()) next.set("model", draftModel.trim());
    if (includeArchived) next.set("archived", "true");
    setSearchParams(next, { replace: true });
  }

  function toggleArchived() {
    const next = new URLSearchParams(searchParams);
    if (includeArchived) next.delete("archived");
    else next.set("archived", "true");
    setSearchParams(next, { replace: true });
  }

  function refreshAll() {
    void queryClient.invalidateQueries({ queryKey: ["codex-history-status"] });
    void queryClient.invalidateQueries({ queryKey: ["codex-history-sessions"] });
    void queryClient.invalidateQueries({ queryKey: ["codex-history-session"] });
  }

  function sessionLink(s: SessionSummary): string {
    return `/codex-history/s/${enc(s.id)}${qs({ codexRoot })}`;
  }

  return (
    <div className="cursor-chat-root min-h-[60vh]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--fg)]">Codex 对话</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            读取本机 Codex 线程索引与 rollout JSONL，默认隐藏已归档线程。
          </p>
        </div>
        <button type="button" className={btnGhost} onClick={() => refreshAll()}>
          刷新列表
        </button>
      </div>

      {status.data && (
        <div className="mt-6 rounded-xl border border-neutral-200/80 bg-white px-4 py-3 text-xs text-neutral-600 shadow-sm">
          <div>
            <span className="font-medium text-neutral-500">Codex root · </span>
            <span className="break-all font-mono text-neutral-800">{status.data.codexRoot}</span>
          </div>
          <div className="mt-1">
            <span className="font-medium text-neutral-500">state DB · </span>
            <span className="break-all font-mono text-neutral-800">{status.data.stateDbPath}</span>
            <span className="ml-2 text-neutral-400">
              {status.data.platform}
              {status.data.envCodexHome ? " · CODEX_HOME" : ""}
            </span>
          </div>
        </div>
      )}

      <form onSubmit={applyFilters} className="mt-6 grid gap-3 rounded-xl border border-neutral-200/80 bg-white p-4 shadow-sm lg:grid-cols-[1.2fr_1.4fr_0.8fr_0.8fr_auto]">
        <input className={inputClass + " font-mono text-xs"} value={draftRoot} onChange={(e) => setDraftRoot(e.target.value)} placeholder="Codex root: ~/.codex" />
        <input className={inputClass + " font-mono text-xs"} value={draftCwd} onChange={(e) => setDraftCwd(e.target.value)} placeholder="cwd filter" />
        <input className={inputClass + " font-mono text-xs"} value={draftBranch} onChange={(e) => setDraftBranch(e.target.value)} placeholder="branch" />
        <input className={inputClass + " font-mono text-xs"} value={draftModel} onChange={(e) => setDraftModel(e.target.value)} placeholder="model" />
        <button type="submit" className={btnPrimary}>应用</button>
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-neutral-600">
        <button type="button" className={btnGhost} onClick={toggleArchived}>
          {includeArchived ? "隐藏已归档" : "包含已归档"}
        </button>
        <span>当前：{includeArchived ? "包含已归档线程" : "仅显示未归档线程"}</span>
        {sessions.data && (
          <span>
            数据源：{sessions.data.source === "sqlite" ? "SQLite threads" : "JSONL fallback"}
            {sessions.data.truncated ? ` · 已截断 ${sessions.data.scannedCount}` : ` · ${sessions.data.scannedCount} 条`}
          </span>
        )}
      </div>

      {sessions.data && sessions.data.diagnostics.length > 0 && (
        <div className="mt-4 space-y-2 rounded-xl border border-amber-200/80 bg-amber-50/80 px-4 py-3 text-sm text-amber-950">
          {sessions.data.diagnostics.map((d) => (
            <div key={`${d.kind}-${d.path ?? d.message}`}>
              <span className="font-semibold">{d.kind}</span>
              <span className="ml-2">{d.message}</span>
              {d.path && <span className="ml-2 break-all font-mono text-xs text-amber-800">{d.path}</span>}
            </div>
          ))}
        </div>
      )}

      {sessions.isLoading && <p className="mt-8 text-sm text-neutral-500">加载中...</p>}
      {sessions.isError && (
        <p className="mt-8 text-sm text-red-700" role="alert">
          {(sessions.error as Error).message}
        </p>
      )}

      <ul className="mt-6 space-y-3">
        {sessions.data?.sessions.map((s) => {
          const codex = s.metadata?.codex;
          return (
            <li key={s.id}>
              <Link
                to={sessionLink(s)}
                className="block rounded-xl border border-neutral-200/80 bg-white px-4 py-4 shadow-sm transition hover:border-blue-200 hover:shadow-md"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-900">
                    {s.title?.trim() || "无标题会话"}
                  </h2>
                  {codex?.degraded && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-950">
                      degraded · {codex.degradationReason}
                    </span>
                  )}
                  {codex?.archived && (
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700">
                      archived
                    </span>
                  )}
                </div>
                <p className="mt-2 line-clamp-2 text-sm text-neutral-600">{s.preview}</p>
                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500">
                  <span>{s.messageCount} 条消息</span>
                  <span className="text-neutral-300">·</span>
                  <span>更新 {formatFileTimeMs(new Date(s.lastUpdatedAt).getTime())}</span>
                  {codex?.gitBranch && <span>· {codex.gitBranch}</span>}
                  {codex?.model && <span>· {codex.model}</span>}
                </div>
                {s.workspacePath && (
                  <div className="mt-2 break-all font-mono text-[11px] text-neutral-500">
                    {s.workspacePath}
                  </div>
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      {sessions.data && sessions.data.sessions.length === 0 && (
        <p className="mt-8 rounded-xl border border-dashed border-neutral-200 py-12 text-center text-sm text-neutral-500">
          没有匹配的 Codex 会话。
        </p>
      )}
    </div>
  );
}
