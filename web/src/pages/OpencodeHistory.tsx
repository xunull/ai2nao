import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { OpencodeMyMessagesSheet } from "../components/OpencodeMyMessagesSheet";
import { formatFileTimeMs } from "../util/formatDisplay";

type Diagnostic = { kind: string; message: string; path?: string; count?: number };

type Status = {
  platform: string;
  opencodeRoot: string;
  dbPath: string;
  envOpencodeDataDir: boolean;
};

type OpencodeMetadata = {
  opencode?: {
    directory?: string;
    agent?: string;
    model?: string;
    archived?: boolean;
    tokensInput?: number;
    tokensOutput?: number;
    cost?: number;
  };
};

type ProjectSummary = {
  id: string;
  path: string;
  name: string;
  sessionCount: number;
  lastActiveAt: string;
};

type ProjectsResponse = { ok: true; source: "sqlite"; diagnostics: Diagnostic[]; projects: ProjectSummary[] };

type SessionSummary = {
  id: string;
  index: number;
  title: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  messageCount: number;
  workspaceId: string;
  workspacePath?: string;
  metadata?: OpencodeMetadata;
};

type SessionsResponse = { ok: true; source: "sqlite"; diagnostics: Diagnostic[]; sessions: SessionSummary[] };

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

function fmtTokens(n?: number): string {
  if (!n || n <= 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

const inputClass =
  "w-full rounded-xl border border-neutral-200 bg-white px-3.5 py-2.5 text-sm text-neutral-800 shadow-sm transition placeholder:text-neutral-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20";
const btnPrimary =
  "inline-flex items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500/40 active:scale-[0.98]";
const btnGhost =
  "inline-flex items-center justify-center rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm transition hover:border-blue-200 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500/20";

export function OpencodeHistory() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const opencodeRoot = searchParams.get("opencodeRoot") ?? "";
  const projectId = searchParams.get("projectId") ?? ""; // 选中项目（project.id）
  const agent = searchParams.get("agent") ?? "";
  const model = searchParams.get("model") ?? "";
  const includeArchived = searchParams.get("archived") === "true";
  const [draftRoot, setDraftRoot] = useState(opencodeRoot);
  const [draftAgent, setDraftAgent] = useState(agent);
  const [draftModel, setDraftModel] = useState(model);
  const [openSession, setOpenSession] = useState<{
    sessionId: string;
    title: string;
  } | null>(null);

  useEffect(() => setDraftRoot(opencodeRoot), [opencodeRoot]);
  useEffect(() => setDraftAgent(agent), [agent]);
  useEffect(() => setDraftModel(model), [model]);

  const archivedQs = includeArchived ? "true" : "false";

  const status = useQuery({
    queryKey: ["opencode-history-status", opencodeRoot],
    queryFn: () => apiGet<Status>(`/api/opencode-history/status${qs({ opencodeRoot })}`),
  });

  // 左栏项目 —— 只受 archived 影响。
  const projects = useQuery({
    queryKey: ["opencode-history-projects", archivedQs, opencodeRoot],
    queryFn: () =>
      apiGet<ProjectsResponse>(`/api/opencode-history/projects${qs({ opencodeRoot, archived: archivedQs })}`),
  });

  // 右栏 session —— agent/model/archived 进 key（只刷右栏）。
  const sessions = useQuery({
    queryKey: ["opencode-history-sessions", projectId, agent, model, archivedQs, opencodeRoot],
    queryFn: () =>
      apiGet<SessionsResponse>(
        `/api/opencode-history/sessions${qs({ opencodeRoot, projectId, agent, model, archived: archivedQs })}`
      ),
    enabled: projectId.length > 0,
  });

  const selectedProject = useMemo(
    () => projects.data?.projects.find((p) => p.id === projectId) ?? null,
    [projects.data, projectId]
  );
  const filterActive = agent.trim() !== "" || model.trim() !== "";

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
    patchParams({
      opencodeRoot: draftRoot.trim() || null,
      agent: draftAgent.trim() || null,
      model: draftModel.trim() || null,
    });
  }

  function refreshAll() {
    void queryClient.invalidateQueries({ queryKey: ["opencode-history-status"] });
    void queryClient.invalidateQueries({ queryKey: ["opencode-history-projects"] });
    void queryClient.invalidateQueries({ queryKey: ["opencode-history-sessions"] });
  }

  function sessionLink(s: SessionSummary): string {
    return `/opencode-history/s/${enc(s.id)}${qs({ opencodeRoot })}`;
  }

  return (
    <div className="cursor-chat-root min-h-[60vh]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--fg)]">opencode 对话</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            按项目分组本机 opencode 会话。左侧选项目、右侧看会话,点击进入时间线。默认隐藏已归档。
          </p>
        </div>
        <button type="button" className={btnGhost} onClick={() => refreshAll()}>
          刷新列表
        </button>
      </div>

      {status.data && (
        <div className="mt-6 rounded-xl border border-neutral-200/80 bg-white px-4 py-3 text-xs text-neutral-600 shadow-sm">
          <div>
            <span className="font-medium text-neutral-500">opencode root · </span>
            <span className="break-all font-mono text-neutral-800">{status.data.opencodeRoot}</span>
          </div>
          <div className="mt-1">
            <span className="font-medium text-neutral-500">db · </span>
            <span className="break-all font-mono text-neutral-800">{status.data.dbPath}</span>
            <span className="ml-2 text-neutral-400">
              {status.data.platform}
              {status.data.envOpencodeDataDir ? " · OPENCODE_DATA_DIR" : ""}
            </span>
          </div>
        </div>
      )}

      <form
        onSubmit={applyFilters}
        className="mt-6 grid gap-3 rounded-xl border border-neutral-200/80 bg-white p-4 shadow-sm lg:grid-cols-[1.6fr_0.8fr_0.8fr_auto]"
      >
        <input
          className={inputClass + " font-mono text-xs"}
          value={draftRoot}
          onChange={(e) => setDraftRoot(e.target.value)}
          placeholder="opencode 数据目录: ~/.local/share/opencode"
        />
        <input
          className={inputClass + " font-mono text-xs"}
          value={draftAgent}
          onChange={(e) => setDraftAgent(e.target.value)}
          placeholder="agent(筛右栏)"
        />
        <input
          className={inputClass + " font-mono text-xs"}
          value={draftModel}
          onChange={(e) => setDraftModel(e.target.value)}
          placeholder="model(筛右栏)"
        />
        <button type="submit" className={btnPrimary}>
          应用
        </button>
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-neutral-600">
        <button
          type="button"
          className={btnGhost}
          onClick={() => patchParams({ archived: includeArchived ? null : "true" })}
        >
          {includeArchived ? "隐藏已归档" : "包含已归档"}
        </button>
        <span>当前：{includeArchived ? "包含已归档会话" : "仅显示未归档会话"}</span>
        {projects.data && <span>数据源：SQLite · {projects.data.projects.length} 个项目</span>}
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
        {/* 左栏:项目。min-w-0 防止长 worktree 路径(font-mono 不可换行)撑破列宽 → 整页横滚。 */}
        <div className="min-w-0">
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
              const active = p.id === projectId;
              return (
                <li key={p.id || "(unknown)"}>
                  <button
                    type="button"
                    onClick={() => patchParams({ projectId: p.id })}
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

        {/* 右栏:选中项目的 session。min-w-0 防长标题撑破列。 */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-neutral-700">会话</h2>
            {projectId && sessions.data && (
              <span className="text-xs text-neutral-500">
                匹配 {sessions.data.sessions.length} 条
                {filterActive && selectedProject ? ` / 共 ${selectedProject.sessionCount}` : ""}
              </span>
            )}
          </div>

          {!projectId && (
            <p className="mt-2 rounded-xl border border-dashed border-neutral-200 py-10 text-center text-sm text-neutral-500">
              请先在左侧选择一个项目。
            </p>
          )}
          {projectId && sessions.isLoading && <p className="mt-2 text-sm text-neutral-500">加载中...</p>}
          {projectId && sessions.isError && (
            <p className="mt-2 text-sm text-red-700" role="alert">
              {(sessions.error as Error).message}
            </p>
          )}
          {projectId && sessions.data && sessions.data.sessions.length === 0 && (
            <p className="mt-2 rounded-xl border border-dashed border-neutral-200 py-10 text-center text-sm text-neutral-500">
              该项目在当前过滤下没有会话。
            </p>
          )}

          <ul className="mt-3 space-y-3">
            {projectId &&
              sessions.data?.sessions.map((s) => {
                const oc = s.metadata?.opencode;
                return (
                  <li key={s.id} className="relative">
                    <Link
                      to={sessionLink(s)}
                      className="block rounded-xl border border-neutral-200/80 bg-white px-4 py-4 pr-12 shadow-sm transition hover:border-blue-200 hover:shadow-md"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-900">
                          {s.title?.trim() || "无标题会话"}
                        </h3>
                        {oc?.archived && (
                          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700">
                            archived
                          </span>
                        )}
                      </div>
                      {oc?.directory && (
                        <p className="mt-1 truncate font-mono text-[11px] text-neutral-500">{oc.directory}</p>
                      )}
                      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500">
                        <span>更新 {formatFileTimeMs(new Date(s.lastUpdatedAt).getTime())}</span>
                        {oc?.model && <span>· {oc.model}</span>}
                        {oc?.agent && <span>· {oc.agent}</span>}
                        {(oc?.tokensInput || oc?.tokensOutput) && (
                          <span>
                            · token {fmtTokens(oc?.tokensInput)}↑ / {fmtTokens(oc?.tokensOutput)}↓
                          </span>
                        )}
                      </div>
                    </Link>
                    {/* 按钮是 Link 的兄弟节点(不嵌进 anchor):我的输入(已过滤注入)。 */}
                    <button
                      type="button"
                      onClick={() =>
                        setOpenSession({
                          sessionId: s.id,
                          title: s.title?.trim() || "无标题会话",
                        })
                      }
                      title="我的输入(已过滤注入)"
                      aria-label="我的输入(已过滤注入)"
                      className="absolute right-2.5 top-2.5 rounded-lg border border-neutral-200 bg-white p-1.5 text-neutral-500 shadow-sm transition hover:border-blue-200 hover:bg-slate-50 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    >
                      <MessageSquare className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
          </ul>
        </div>
      </div>

      <OpencodeMyMessagesSheet
        open={openSession !== null}
        onOpenChange={(o) => {
          if (!o) setOpenSession(null);
        }}
        sessionId={openSession?.sessionId ?? ""}
        opencodeRoot={opencodeRoot}
        title={openSession?.title ?? ""}
      />
    </div>
  );
}
