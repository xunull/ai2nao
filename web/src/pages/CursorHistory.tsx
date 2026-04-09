import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { formatFileTimeMs } from "../util/formatDisplay";

type CursorHistoryStatus = {
  platform: string;
  workspaceStorage: string;
  envCursorDataPath: boolean;
};

type WorkspaceRow = {
  id: string;
  path: string;
  dbPath: string;
  sessionCount: number;
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

type SessionsApiResponse = {
  ok: boolean;
  sessions: SessionSummary[];
  total?: number;
  offset?: number;
  limit?: number;
};

/** 列表里展示「所属项目 / 工作区」：全局会话单独说明 */
function workspaceLine(path: string | undefined): { label: string; title: string } {
  const p = path?.trim();
  if (!p) {
    return { label: "未知工作区", title: "Cursor 未写入 workspace 路径" };
  }
  if (p === "Global") {
    return {
      label: "全局存储（未绑定到某个文件夹）",
      title: "仅出现在全局库、composer 未带 workspaceUri 时的会话",
    };
  }
  return { label: p, title: p };
}

type SearchResult = {
  sessionId: string;
  index: number;
  workspacePath?: string;
  createdAt: string;
  matchCount: number;
  snippets: string[];
};

function enc(s: string): string {
  return encodeURIComponent(s);
}

function qs(dataPath: string, extra: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  if (dataPath.trim()) p.set("dataPath", dataPath.trim());
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== "") p.set(k, v);
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

const btnGhostActive =
  "border-blue-400 bg-blue-50/80 text-blue-900 ring-1 ring-blue-200/60";

function tabBtn(active: boolean) {
  return [
    "rounded-t-lg border-b-2 px-4 py-2.5 text-sm font-medium transition -mb-px",
    active
      ? "border-blue-600 text-blue-800"
      : "border-transparent text-neutral-500 hover:border-neutral-200 hover:text-neutral-800",
  ].join(" ");
}

export function CursorHistory() {
  const [searchParams, setSearchParams] = useSearchParams();
  const dataPath = searchParams.get("dataPath") ?? "";
  const workspaceFromUrl = searchParams.get("workspace") ?? "";
  const offsetFromUrl = Math.max(
    0,
    parseInt(searchParams.get("offset") ?? "0", 10) || 0
  );

  const [panel, setPanel] = useState<"browse" | "search">("browse");
  const [workspaceDraft, setWorkspaceDraft] = useState(workspaceFromUrl);
  const [dataPathDraft, setDataPathDraft] = useState(dataPath);
  const [showAdvanced, setShowAdvanced] = useState(Boolean(dataPath.trim()));
  const [allSessions, setAllSessions] = useState(false);
  const [limit, setLimit] = useState(80);
  const [searchQ, setSearchQ] = useState("");
  const [searchActive, setSearchActive] = useState("");

  useEffect(() => {
    setWorkspaceDraft(workspaceFromUrl);
  }, [workspaceFromUrl]);

  useEffect(() => {
    setDataPathDraft(dataPath);
  }, [dataPath]);

  const apiSuffix = useMemo(() => qs(dataPath, {}), [dataPath]);

  const status = useQuery({
    queryKey: ["cursor-history-status", dataPath],
    queryFn: () =>
      apiGet<CursorHistoryStatus>(`/api/cursor-history/status${apiSuffix}`),
  });

  const workspaces = useQuery({
    queryKey: ["cursor-history-workspaces", dataPath],
    queryFn: () =>
      apiGet<{ ok: boolean; workspaces: WorkspaceRow[] }>(
        `/api/cursor-history/workspaces${apiSuffix}`
      ),
  });

  const sessions = useQuery({
    queryKey: [
      "cursor-history-sessions",
      dataPath,
      workspaceFromUrl,
      allSessions,
      limit,
      offsetFromUrl,
    ],
    queryFn: () => {
      const q = qs(dataPath, {
        workspace: workspaceFromUrl || undefined,
        all: allSessions ? "true" : undefined,
        limit: allSessions ? undefined : String(limit),
        offset:
          allSessions || offsetFromUrl === 0 ? undefined : String(offsetFromUrl),
      });
      return apiGet<SessionsApiResponse>(`/api/cursor-history/sessions${q}`);
    },
  });

  /** 服务端会把过大的 offset 夹到最后一页，同步回 URL */
  useEffect(() => {
    if (allSessions || sessions.isLoading || sessions.isFetching) return;
    const srv = sessions.data?.offset;
    if (srv === undefined) return;
    if (srv !== offsetFromUrl) {
      const next = new URLSearchParams(searchParams);
      if (srv <= 0) next.delete("offset");
      else next.set("offset", String(srv));
      setSearchParams(next, { replace: true });
    }
  }, [
    allSessions,
    sessions.isLoading,
    sessions.isFetching,
    sessions.data?.offset,
    offsetFromUrl,
    searchParams,
    setSearchParams,
  ]);

  const search = useQuery({
    queryKey: ["cursor-history-search", dataPath, workspaceFromUrl, searchActive],
    queryFn: () => {
      const q = qs(dataPath, {
        q: searchActive,
        limit: "40",
        context: "100",
        workspace: workspaceFromUrl || undefined,
      });
      return apiGet<{
        ok: boolean;
        q: string;
        results: SearchResult[];
      }>(`/api/cursor-history/search${q}`);
    },
    enabled: searchActive.length > 0,
  });

  function applyFilters() {
    const next = new URLSearchParams(searchParams);
    if (dataPathDraft.trim()) next.set("dataPath", dataPathDraft.trim());
    else next.delete("dataPath");
    if (workspaceDraft.trim()) next.set("workspace", workspaceDraft.trim());
    else next.delete("workspace");
    next.delete("offset");
    setSearchParams(next, { replace: true });
  }

  function setPageOffset(nextOffset: number) {
    const next = new URLSearchParams(searchParams);
    if (nextOffset <= 0) next.delete("offset");
    else next.set("offset", String(nextOffset));
    setSearchParams(next, { replace: true });
  }

  function pickWorkspace(path: string | null) {
    const next = new URLSearchParams(searchParams);
    if (path?.trim()) next.set("workspace", path.trim());
    else next.delete("workspace");
    next.delete("offset");
    setWorkspaceDraft(path?.trim() ?? "");
    setSearchParams(next, { replace: true });
  }

  function runSearch(e: FormEvent) {
    e.preventDefault();
    const t = searchQ.trim();
    setSearchActive(t);
  }

  const sessionLink = (id: string) => {
    const q = qs(dataPath, {});
    return `/cursor-history/s/${enc(id)}${q}`;
  };

  return (
    <div className="cursor-chat-root min-h-[60vh]">
      <h1 className="text-xl font-semibold text-[var(--fg)]">Cursor 对话</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        本机历史会话。主路径：先浏览列表；用下方「按项目」可只看某个文件夹/工作区；分页用上一页/下一页或 URL 参数{" "}
        <code className="rounded bg-neutral-100 px-1 text-[11px]">offset</code>
        。数据源与路径在「数据源与筛选」里。
      </p>

      <div
        className="mt-6 flex gap-1 border-b border-[var(--border)]"
        role="tablist"
        aria-label="Cursor 对话模式"
      >
        <button
          type="button"
          role="tab"
          aria-selected={panel === "browse"}
          className={tabBtn(panel === "browse")}
          onClick={() => setPanel("browse")}
        >
          浏览会话
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={panel === "search"}
          className={tabBtn(panel === "search")}
          onClick={() => setPanel("search")}
        >
          搜索内容
        </button>
      </div>

      <div className="mt-6">
        {status.isError && (
          <div
            className="mb-6 flex gap-3 rounded-xl border border-red-200/80 bg-red-50/90 px-4 py-3 text-sm text-red-900"
            role="alert"
          >
            <span className="shrink-0 font-semibold">状态</span>
            <span>{(status.error as Error).message}</span>
          </div>
        )}

        {panel === "browse" && (
          <>
            <details className="group mb-6 rounded-xl border border-neutral-200/80 bg-white shadow-sm open:shadow-md">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-neutral-800 [&::-webkit-details-marker]:hidden">
                <span>数据源与筛选</span>
                <span className="text-xs font-normal text-neutral-400">
                  工作区、条数、自定义路径
                </span>
              </summary>
              <div className="space-y-4 border-t border-neutral-100 px-4 py-4">
                {status.data && (
                  <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-neutral-600">
                    <span className="font-medium text-neutral-500">当前数据根 · </span>
                    <span className="break-all font-mono text-neutral-800">
                      {status.data.workspaceStorage}
                    </span>
                    <span className="ml-2 text-neutral-400">
                      {status.data.platform}
                      {status.data.envCursorDataPath ? " · CURSOR_DATA_PATH" : ""}
                    </span>
                  </div>
                )}

                <button
                  type="button"
                  className="text-sm font-medium text-blue-600 hover:text-blue-800"
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  {showAdvanced ? "收起" : "展开"} 自定义 CURSOR_DATA_PATH
                </button>
                {showAdvanced && (
                  <label className="block max-w-xl">
                    <span className="mb-1.5 block text-xs font-medium text-neutral-500">
                      路径覆盖
                    </span>
                    <input
                      className={inputClass + " font-mono text-xs"}
                      value={dataPathDraft}
                      onChange={(e) => setDataPathDraft(e.target.value)}
                      placeholder="留空使用默认"
                    />
                  </label>
                )}

                <div className="flex flex-col gap-4 lg:flex-row lg:flex-wrap lg:items-end">
                  <label className="min-w-0 flex-1 lg:min-w-[16rem]">
                    <span className="mb-1.5 block text-xs font-medium text-neutral-500">
                      工作区路径过滤
                    </span>
                    <input
                      className={inputClass}
                      value={workspaceDraft}
                      onChange={(e) => setWorkspaceDraft(e.target.value)}
                      list="cursor-workspace-paths"
                      placeholder="全部工作区"
                    />
                    <datalist id="cursor-workspace-paths">
                      {(workspaces.data?.workspaces ?? []).map((w) => (
                        <option key={w.id} value={w.path} />
                      ))}
                    </datalist>
                  </label>
                  <label className="flex cursor-pointer items-center gap-2.5 text-sm text-neutral-700">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-neutral-300 text-blue-600 focus:ring-blue-500/30"
                      checked={allSessions}
                      onChange={(e) => setAllSessions(e.target.checked)}
                    />
                    列出全部（较慢）
                  </label>
                  {!allSessions && (
                    <label className="w-full sm:w-28">
                      <span className="mb-1.5 block text-xs font-medium text-neutral-500">
                        条数上限
                      </span>
                      <input
                        type="number"
                        min={1}
                        max={500}
                        className={inputClass}
                        value={limit}
                        onChange={(e) => setLimit(Number(e.target.value) || 50)}
                      />
                    </label>
                  )}
                  <button type="button" className={btnPrimary} onClick={applyFilters}>
                    应用筛选
                  </button>
                </div>
              </div>
            </details>

            <section className="rounded-xl border border-neutral-200/80 bg-white p-4 shadow-sm sm:p-5">
              <div className="flex flex-wrap items-end justify-between gap-4 border-b border-neutral-100 pb-3">
                <h2 className="text-sm font-semibold text-neutral-800">会话列表</h2>
                {sessions.data && !sessions.isLoading && (
                  <span className="text-xs text-neutral-500">
                    {allSessions ? (
                      <>共 {sessions.data.sessions.length} 条（已列出全部）</>
                    ) : (
                      (() => {
                        const total = sessions.data.total ?? 0;
                        const off = sessions.data.offset ?? offsetFromUrl;
                        const rows = sessions.data.sessions.length;
                        const from = total === 0 ? 0 : off + 1;
                        const to = off + rows;
                        return (
                          <>
                            第 {from}–{to} 条，共 {total} 条
                          </>
                        );
                      })()
                    )}
                  </span>
                )}
              </div>

              {workspaces.data && workspaces.data.workspaces.length > 0 && (
                <div className="mt-4 rounded-lg border border-neutral-100 bg-slate-50/50 px-3 py-3">
                  <p className="text-xs font-medium text-neutral-600">按项目（工作区路径）</p>
                  <p className="mt-0.5 text-[11px] text-neutral-400">
                    点选后只显示该路径下的会话（与上方「工作区路径过滤」一致，可分享带{" "}
                    <code className="rounded bg-white px-0.5">workspace=</code> 的链接）。
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={[btnGhost, !workspaceFromUrl ? btnGhostActive : ""].join(" ")}
                      onClick={() => pickWorkspace(null)}
                    >
                      全部工作区
                    </button>
                    {workspaces.data.workspaces.slice(0, 20).map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        title={w.path}
                        className={[
                          btnGhost,
                          workspaceFromUrl === w.path ? btnGhostActive : "",
                          "max-w-[14rem] truncate",
                        ].join(" ")}
                        onClick={() => pickWorkspace(w.path)}
                      >
                        <span className="truncate">
                          {w.path.replace(/^.*\//, "") || w.path}
                          <span className="ml-1 tabular-nums text-neutral-400">({w.sessionCount})</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {sessions.isLoading && (
                <div className="mt-4 space-y-3 animate-pulse" aria-busy>
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-[4.5rem] rounded-xl bg-gradient-to-r from-neutral-100 to-neutral-50"
                    />
                  ))}
                </div>
              )}

              {sessions.isError && (
                <p className="mt-4 text-sm text-red-600">
                  {(sessions.error as Error).message}
                </p>
              )}

              {sessions.data &&
                sessions.data.sessions.length === 0 &&
                !sessions.isLoading && (
                  <div className="mt-8 rounded-xl border border-dashed border-neutral-200 bg-slate-50/50 px-6 py-12 text-center">
                    <p className="text-sm font-medium text-neutral-700">暂无会话</p>
                    <p className="mt-2 text-sm text-neutral-500">
                      展开「数据源与筛选」取消工作区限制、勾选「列出全部」，或确认本机已用 Cursor 打开过项目。
                    </p>
                  </div>
                )}

              {sessions.data && sessions.data.sessions.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {sessions.data.sessions.map((s) => (
                    <li key={s.id}>
                      <Link
                        to={sessionLink(s.id)}
                        className="group block rounded-xl border border-transparent px-3 py-3 transition hover:border-neutral-200 hover:bg-slate-50/80"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <span className="font-medium text-neutral-900 group-hover:text-blue-800">
                            {s.title?.trim() || "无标题会话"}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-neutral-400">
                            {formatFileTimeMs(new Date(s.lastUpdatedAt).getTime())}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-500">
                          <span>{s.messageCount} 条消息</span>
                          <span className="text-neutral-300">·</span>
                          <span
                            className="max-w-full truncate text-[11px] text-neutral-600"
                            title={workspaceLine(s.workspacePath).title}
                          >
                            <span className="font-medium text-neutral-500">项目 </span>
                            <span className="font-mono text-neutral-600">
                              {workspaceLine(s.workspacePath).label}
                            </span>
                          </span>
                        </div>
                        {s.preview && (
                          <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-neutral-500">
                            {s.preview}
                          </p>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}

              {sessions.data &&
                !allSessions &&
                (sessions.data.total ?? 0) > 0 &&
                (sessions.data.limit ?? limit) > 0 && (
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 pt-4">
                    <span className="text-xs text-neutral-500">
                      每页 {sessions.data.limit ?? limit} 条
                      {(sessions.data.offset ?? 0) > 0 &&
                        ` · 从第 ${(sessions.data.offset ?? 0) + 1} 条开始`}
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className={btnGhost + " px-4 py-2 text-sm"}
                        disabled={(sessions.data.offset ?? 0) <= 0 || sessions.isFetching}
                        onClick={() =>
                          setPageOffset(
                            Math.max(0, (sessions.data.offset ?? 0) - (sessions.data.limit ?? limit))
                          )
                        }
                      >
                        上一页
                      </button>
                      <button
                        type="button"
                        className={btnGhost + " px-4 py-2 text-sm"}
                        disabled={
                          (sessions.data.offset ?? 0) + sessions.data.sessions.length >=
                            (sessions.data.total ?? 0) || sessions.isFetching
                        }
                        onClick={() =>
                          setPageOffset((sessions.data.offset ?? 0) + (sessions.data.limit ?? limit))
                        }
                      >
                        下一页
                      </button>
                    </div>
                  </div>
                )}
            </section>
          </>
        )}

        {panel === "search" && (
          <section className="rounded-xl border border-neutral-200/80 bg-white p-4 shadow-sm sm:p-5">
            <p className="text-xs text-neutral-500">
              在当前数据根与（若已应用）工作区过滤范围内检索正文。与顶部「浏览会话」列表相互独立。
            </p>
            <form
              onSubmit={runSearch}
              className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center"
            >
              <input
                className={inputClass + " sm:min-w-[14rem] sm:flex-1"}
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder="关键词…"
              />
              <button type="submit" className={btnPrimary + " sm:shrink-0"}>
                搜索
              </button>
            </form>
            {search.isError && (
              <p className="mt-3 text-sm text-red-600">{(search.error as Error).message}</p>
            )}
            {search.isFetching && searchActive && (
              <p className="mt-3 text-sm text-neutral-500">搜索中…</p>
            )}
            {!searchActive && (
              <p className="mt-6 text-center text-sm text-neutral-400">
                输入关键词后回车或点击搜索
              </p>
            )}
            {search.data && search.data.results.length === 0 && (
              <div className="mt-6 rounded-xl border border-dashed border-neutral-200 bg-slate-50/50 py-10 text-center text-sm text-neutral-500">
                没有包含「{search.data.q}」的会话
              </div>
            )}
            {search.data && search.data.results.length > 0 && (
              <ul className="mt-4 space-y-3">
                {search.data.results.map((r) => (
                  <li
                    key={`${r.sessionId}-${r.index}`}
                    className="rounded-xl border border-neutral-100 bg-slate-50/40 p-4 transition hover:border-blue-200/60 hover:bg-white hover:shadow-sm"
                  >
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Link
                        className="font-medium text-blue-700 hover:text-blue-900 hover:underline"
                        to={sessionLink(r.sessionId)}
                      >
                        会话 {r.sessionId.slice(0, 8)}…
                      </Link>
                      <span className="text-xs text-neutral-500">
                        {r.matchCount} 处匹配 · #{r.index}
                        {r.workspacePath ? (
                          <>
                            {" "}
                            ·{" "}
                            <span className="font-mono text-[11px]" title={workspaceLine(r.workspacePath).title}>
                              {workspaceLine(r.workspacePath).label}
                            </span>
                          </>
                        ) : null}
                      </span>
                    </div>
                    {r.snippets.slice(0, 3).map((snippet, i) => (
                      <pre
                        key={i}
                        className="mt-3 max-h-32 overflow-auto rounded-lg border border-neutral-200/80 bg-white p-3 text-xs leading-relaxed text-neutral-700"
                      >
                        {snippet}
                      </pre>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
