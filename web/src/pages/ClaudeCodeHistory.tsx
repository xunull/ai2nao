import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { formatFileTimeMs } from "../util/formatDisplay";

type Status = {
  platform: string;
  projectsRoot: string;
  envClaudeCodeProjectsRoot: boolean;
};

type ProjectRow = {
  id: string;
  path: string;
  sessionCount: number;
  decodedWorkspacePath: string | null;
  slugDecodeIncomplete: boolean;
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
};

function enc(s: string): string {
  return encodeURIComponent(s);
}

function qs(
  projectsRoot: string,
  extra: Record<string, string | undefined>
): string {
  const p = new URLSearchParams();
  if (projectsRoot.trim()) p.set("projectsRoot", projectsRoot.trim());
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== "") p.set(k, v);
  }
  const q = p.toString();
  return q ? `?${q}` : "";
}

/** 仅展示路径最后两级目录名，例如 `/a/b/c/d` → `c/d` */
function lastTwoPathLevels(absPath: string): string {
  const parts = absPath.split(/[/\\]+/).filter(Boolean);
  if (parts.length === 0) return absPath;
  if (parts.length <= 2) return parts.join("/");
  return parts.slice(-2).join("/");
}

const inputClass =
  "w-full rounded-xl border border-neutral-200 bg-white px-3.5 py-2.5 text-sm text-neutral-800 shadow-sm transition placeholder:text-neutral-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20";

const btnPrimary =
  "inline-flex items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500/40 active:scale-[0.98]";

const btnGhost =
  "inline-flex items-center justify-center rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm transition hover:border-blue-200 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500/20";

export function ClaudeCodeHistory() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectsRoot = searchParams.get("projectsRoot") ?? "";
  const projectFromUrl = searchParams.get("project") ?? "";
  const [projectsRootDraft, setProjectsRootDraft] = useState(projectsRoot);

  useEffect(() => {
    setProjectsRootDraft(projectsRoot);
  }, [projectsRoot]);

  const apiSuffix = useMemo(() => qs(projectsRoot, {}), [projectsRoot]);

  const status = useQuery({
    queryKey: ["claude-code-history-status", projectsRoot],
    queryFn: () =>
      apiGet<Status>(`/api/claude-code-history/status${apiSuffix}`),
  });

  const projects = useQuery({
    queryKey: ["claude-code-history-projects", projectsRoot],
    queryFn: () =>
      apiGet<{ ok: boolean; projects: ProjectRow[] }>(
        `/api/claude-code-history/projects${apiSuffix}`
      ),
  });

  const sessions = useQuery({
    queryKey: [
      "claude-code-history-sessions",
      projectsRoot,
      projectFromUrl,
    ],
    queryFn: () =>
      apiGet<{ ok: boolean; sessions: SessionSummary[] }>(
        `/api/claude-code-history/projects/${enc(projectFromUrl)}/sessions${apiSuffix}`
      ),
    enabled: projectFromUrl.length > 0,
  });

  function applyRoot(e: FormEvent) {
    e.preventDefault();
    const next = new URLSearchParams(searchParams);
    if (projectsRootDraft.trim()) {
      next.set("projectsRoot", projectsRootDraft.trim());
    } else {
      next.delete("projectsRoot");
    }
    next.delete("project");
    setSearchParams(next, { replace: true });
  }

  function pickProject(id: string | null) {
    const next = new URLSearchParams(searchParams);
    if (id?.trim()) next.set("project", id.trim());
    else next.delete("project");
    setSearchParams(next, { replace: true });
  }

  function sessionLink(s: SessionSummary): string {
    const q = qs(projectsRoot, { projectId: projectFromUrl });
    return `/claude-code-history/s/${enc(s.id)}${q}`;
  }

  function refreshAll() {
    void queryClient.invalidateQueries({ queryKey: ["claude-code-history-status"] });
    void queryClient.invalidateQueries({ queryKey: ["claude-code-history-projects"] });
    void queryClient.invalidateQueries({ queryKey: ["claude-code-history-sessions"] });
    void queryClient.invalidateQueries({ queryKey: ["claude-code-history-session"] });
  }

  const selectedProject = projectFromUrl;

  return (
    <div className="cursor-chat-root min-h-[60vh]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--fg)]">Claude Code 对话</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            读取本机 <code className="rounded bg-neutral-100 px-1 text-[11px]">~/.claude/projects</code>{" "}
            下各项目的 <code className="rounded bg-neutral-100 px-1 text-[11px]">*.jsonl</code>{" "}
            会话。选择项目后查看会话列表，点击进入时间线。
          </p>
        </div>
        <button type="button" className={btnGhost} onClick={() => refreshAll()}>
          刷新列表
        </button>
      </div>

      {status.isError && (
        <div
          className="mt-6 rounded-xl border border-red-200/80 bg-red-50/90 px-4 py-3 text-sm text-red-900"
          role="alert"
        >
          {(status.error as Error).message}
        </div>
      )}

      <details className="group mt-6 rounded-xl border border-neutral-200/80 bg-white shadow-sm open:shadow-md">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-neutral-800 [&::-webkit-details-marker]:hidden">
          <span>数据源与路径</span>
          <span className="text-xs font-normal text-neutral-400">
            projectsRoot 覆盖
          </span>
        </summary>
        <div className="space-y-4 border-t border-neutral-100 px-4 py-4">
          {status.data && (
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-neutral-600">
              <span className="font-medium text-neutral-500">当前根目录 · </span>
              <span className="break-all font-mono text-neutral-800">
                {status.data.projectsRoot}
              </span>
              <span className="ml-2 text-neutral-400">
                {status.data.platform}
                {status.data.envClaudeCodeProjectsRoot
                  ? " · CLAUDE_CODE_PROJECTS_ROOT"
                  : ""}
              </span>
            </div>
          )}
          <form onSubmit={applyRoot} className="max-w-xl space-y-2">
            <label className="block text-xs font-medium text-neutral-500">
              自定义 projects 根路径（可选）
            </label>
            <input
              className={inputClass + " font-mono text-xs"}
              value={projectsRootDraft}
              onChange={(e) => setProjectsRootDraft(e.target.value)}
              placeholder="~/.claude/projects"
              autoComplete="off"
            />
            <button type="submit" className={btnPrimary}>
              应用路径
            </button>
          </form>
        </div>
      </details>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="cc-projects-heading">
          <h2 id="cc-projects-heading" className="text-sm font-semibold text-neutral-800">
            项目
          </h2>
          {projects.isLoading && (
            <p className="mt-2 text-sm text-neutral-500">加载中…</p>
          )}
          {projects.isError && (
            <p className="mt-2 text-sm text-red-700" role="alert">
              {(projects.error as Error).message}
            </p>
          )}
          {projects.data && projects.data.projects.length === 0 && (
            <p className="mt-2 text-sm text-neutral-500">未发现项目子目录。</p>
          )}
          <ul className="mt-3 max-h-[28rem] space-y-1 overflow-auto rounded-xl border border-neutral-200/80 bg-white p-2 text-sm">
            {projects.data?.projects.map((p) => {
              const active = p.id === selectedProject;
              const label =
                p.decodedWorkspacePath != null
                  ? lastTwoPathLevels(p.decodedWorkspacePath)
                  : null;
              const titleTip =
                p.decodedWorkspacePath != null
                  ? p.decodedWorkspacePath
                  : undefined;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => pickProject(p.id)}
                    title={titleTip}
                    className={[
                      "w-full rounded-lg px-3 py-2 text-left transition",
                      active
                        ? "bg-blue-50 font-medium text-blue-900 ring-1 ring-blue-200"
                        : "hover:bg-slate-50 text-neutral-800",
                    ].join(" ")}
                  >
                    {label != null ? (
                      <div className="break-all font-mono text-sm text-neutral-900">
                        {label}
                      </div>
                    ) : (
                      <div className="text-sm text-amber-900/90">
                        未能从本机路径完全还原（仍可浏览会话）
                      </div>
                    )}
                    <div className="mt-0.5 text-[11px] text-neutral-500">
                      {p.sessionCount} 个会话
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-labelledby="cc-sessions-heading">
          <h2 id="cc-sessions-heading" className="text-sm font-semibold text-neutral-800">
            会话
          </h2>
          {!selectedProject && (
            <p className="mt-2 text-sm text-neutral-500">请先选择一个项目。</p>
          )}
          {selectedProject && sessions.isLoading && (
            <p className="mt-2 text-sm text-neutral-500">加载会话…</p>
          )}
          {selectedProject && sessions.isError && (
            <p className="mt-2 text-sm text-red-700" role="alert">
              {(sessions.error as Error).message}
            </p>
          )}
          {selectedProject && sessions.data && sessions.data.sessions.length === 0 && (
            <p className="mt-2 text-sm text-neutral-500">该项目下没有 .jsonl 会话。</p>
          )}
          <ul className="mt-3 max-h-[28rem] space-y-2 overflow-auto">
            {sessions.data?.sessions.map((s) => (
              <li key={s.id}>
                <Link
                  to={sessionLink(s)}
                  className="block rounded-xl border border-neutral-200/80 bg-white px-4 py-3 shadow-sm transition hover:border-blue-200 hover:bg-slate-50/80"
                >
                  <div className="font-medium text-neutral-900">
                    {s.title?.trim() || s.id.slice(0, 8) + "…"}
                  </div>
                  <div className="mt-1 line-clamp-2 text-xs text-neutral-600">
                    {s.preview}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-neutral-500">
                    <span>{s.messageCount} 条</span>
                    <span>·</span>
                    <span>
                      {formatFileTimeMs(new Date(s.lastUpdatedAt).getTime())}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
