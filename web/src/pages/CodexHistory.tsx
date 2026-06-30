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
  };
};

type ProjectSummary = {
  id: string;
  path: string;
  name: string;
  sessionCount: number;
  lastActiveAt: string;
};

type ProjectsResponse = {
  ok: true;
  source: "sqlite" | "fallback";
  diagnostics: Diagnostic[];
  projects: ProjectSummary[];
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
  const cwd = searchParams.get("cwd") ?? ""; // 选中项目
  const gitBranch = searchParams.get("gitBranch") ?? "";
  const model = searchParams.get("model") ?? "";
  const includeArchived = searchParams.get("archived") === "true";
  const [draftRoot, setDraftRoot] = useState(codexRoot);
  const [draftBranch, setDraftBranch] = useState(gitBranch);
  const [draftModel, setDraftModel] = useState(model);

  useEffect(() => setDraftRoot(codexRoot), [codexRoot]);
  useEffect(() => setDraftBranch(gitBranch), [gitBranch]);
  useEffect(() => setDraftModel(model), [model]);

  const archivedQs = includeArchived ? "true" : "false";

  const status = useQuery({
    queryKey: ["codex-history-status", codexRoot],
    queryFn: () => apiGet<Status>(`/api/codex-history/status${qs({ codexRoot })}`),
  });

  // 左栏项目列表 —— D1:只受 archived 影响(branch/model 不进 key、不刷新左栏)。
  const projects = useQuery({
    queryKey: ["codex-history-projects", archivedQs, codexRoot],
    queryFn: () =>
      apiGet<ProjectsResponse>(
        `/api/codex-history/projects${qs({ codexRoot, archived: archivedQs })}`
      ),
  });

  // 右栏:选中项目的 session —— branch/model/archived 都进 key(改它们只刷右栏)。
  const sessions = useQuery({
    queryKey: ["codex-history-sessions", cwd, gitBranch, model, archivedQs, codexRoot],
    queryFn: () =>
      apiGet<SessionsResponse>(
        `/api/codex-history/sessions${qs({
          codexRoot,
          cwd,
          gitBranch,
          model,
          archived: archivedQs,
        })}`
      ),
    enabled: cwd.length > 0,
  });

  const selectedProject = useMemo(
    () => projects.data?.projects.find((p) => p.id === cwd) ?? null,
    [projects.data, cwd]
  );
  const filterActive = gitBranch.trim() !== "" || model.trim() !== "";

  function patchParams(patch: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    setSearchParams(next, { replace: true });
  }

  function applyFilters(e: FormEvent) {
    e.preventDefault();
    // 只动 branch/model/root —— 不碰 cwd(选中项目),只刷右栏。
    patchParams({
      codexRoot: draftRoot.trim() || null,
      gitBranch: draftBranch.trim() || null,
      model: draftModel.trim() || null,
    });
  }

  function selectProject(id: string) {
    patchParams({ cwd: id });
  }

  function toggleArchived() {
    patchParams({ archived: includeArchived ? null : "true" });
  }

  function refreshAll() {
    void queryClient.invalidateQueries({ queryKey: ["codex-history-status"] });
    void queryClient.invalidateQueries({ queryKey: ["codex-history-projects"] });
    void queryClient.invalidateQueries({ queryKey: ["codex-history-sessions"] });
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
            按项目(cwd)分组本机 Codex 线程。左侧选项目、右侧看会话,点击进入时间线。默认隐藏已归档。
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

      <form onSubmit={applyFilters} className="mt-6 grid gap-3 rounded-xl border border-neutral-200/80 bg-white p-4 shadow-sm lg:grid-cols-[1.6fr_0.8fr_0.8fr_auto]">
        <input className={inputClass + " font-mono text-xs"} value={draftRoot} onChange={(e) => setDraftRoot(e.target.value)} placeholder="Codex root: ~/.codex" />
        <input className={inputClass + " font-mono text-xs"} value={draftBranch} onChange={(e) => setDraftBranch(e.target.value)} placeholder="branch(筛右栏)" />
        <input className={inputClass + " font-mono text-xs"} value={draftModel} onChange={(e) => setDraftModel(e.target.value)} placeholder="model(筛右栏)" />
        <button type="submit" className={btnPrimary}>应用</button>
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-neutral-600">
        <button type="button" className={btnGhost} onClick={toggleArchived}>
          {includeArchived ? "隐藏已归档" : "包含已归档"}
        </button>
        <span>当前：{includeArchived ? "包含已归档线程" : "仅显示未归档线程"}</span>
        {projects.data && (
          <span>
            数据源：{projects.data.source === "sqlite" ? "SQLite threads" : "JSONL fallback"}
            {` · ${projects.data.projects.length} 个项目`}
          </span>
        )}
      </div>

      {projects.data && projects.data.diagnostics.length > 0 && (
        <div className="mt-4 space-y-2 rounded-xl border border-amber-200/80 bg-amber-50/80 px-4 py-3 text-sm text-amber-950">
          {projects.data.diagnostics.map((d) => (
            <div key={`${d.kind}-${d.path ?? d.message}`}>
              <span className="font-semibold">{d.kind}</span>
              <span className="ml-2">{d.message}</span>
              {d.path && <span className="ml-2 break-all font-mono text-xs text-amber-800">{d.path}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        {/* 左栏:项目 */}
        <div>
          <h2 className="text-sm font-semibold text-neutral-700">项目</h2>
          {projects.isLoading && <p className="mt-2 text-sm text-neutral-500">加载中...</p>}
          {projects.isError && (
            <p className="mt-2 text-sm text-red-700" role="alert">
              {(projects.error as Error).message}
            </p>
          )}
          {projects.data && projects.data.projects.length === 0 && (
            <p className="mt-2 rounded-xl border border-dashed border-neutral-200 py-10 text-center text-sm text-neutral-500">
              没有匹配的项目。
            </p>
          )}
          <ul className="mt-3 space-y-2">
            {projects.data?.projects.map((p) => {
              const active = p.id === cwd;
              return (
                <li key={p.id || "(unknown)"}>
                  <button
                    type="button"
                    onClick={() => selectProject(p.id)}
                    className={[
                      "w-full rounded-xl border px-4 py-3 text-left shadow-sm transition",
                      active
                        ? "border-blue-300 bg-blue-50/80 ring-1 ring-blue-200"
                        : "border-neutral-200/80 bg-white hover:border-blue-200 hover:bg-slate-50",
                    ].join(" ")}
                  >
                    <div className="truncate text-sm font-semibold text-neutral-900">{p.name}</div>
                    {p.path && (
                      <div className="mt-0.5 truncate font-mono text-[11px] text-neutral-500">{p.path}</div>
                    )}
                    <div className="mt-1 flex items-center justify-between text-[11px] text-neutral-500">
                      <span>{p.sessionCount} 会话</span>
                      <span>{formatFileTimeMs(new Date(p.lastActiveAt).getTime())}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* 右栏:选中项目的 session */}
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-neutral-700">会话</h2>
            {cwd && sessions.data && (
              <span className="text-xs text-neutral-500">
                匹配 {sessions.data.sessions.length} 条
                {filterActive && selectedProject ? ` / 共 ${selectedProject.sessionCount}` : ""}
              </span>
            )}
          </div>

          {!cwd && (
            <p className="mt-2 rounded-xl border border-dashed border-neutral-200 py-10 text-center text-sm text-neutral-500">
              请先在左侧选择一个项目。
            </p>
          )}
          {cwd && sessions.isLoading && <p className="mt-2 text-sm text-neutral-500">加载中...</p>}
          {cwd && sessions.isError && (
            <p className="mt-2 text-sm text-red-700" role="alert">
              {(sessions.error as Error).message}
            </p>
          )}
          {cwd && sessions.data && sessions.data.sessions.length === 0 && (
            <p className="mt-2 rounded-xl border border-dashed border-neutral-200 py-10 text-center text-sm text-neutral-500">
              该项目在当前 branch/model 过滤下没有会话。
            </p>
          )}

          <ul className="mt-3 space-y-3">
            {cwd &&
              sessions.data?.sessions.map((s) => {
                const codex = s.metadata?.codex;
                return (
                  <li key={s.id}>
                    <Link
                      to={sessionLink(s)}
                      className="block rounded-xl border border-neutral-200/80 bg-white px-4 py-4 shadow-sm transition hover:border-blue-200 hover:shadow-md"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-900">
                          {s.title?.trim() || "无标题会话"}
                        </h3>
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
                    </Link>
                  </li>
                );
              })}
          </ul>
        </div>
      </div>
    </div>
  );
}
