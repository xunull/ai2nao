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

export function CursorHistory() {
  const [searchParams, setSearchParams] = useSearchParams();
  const dataPath = searchParams.get("dataPath") ?? "";
  const workspaceFromUrl = searchParams.get("workspace") ?? "";

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
    ],
    queryFn: () => {
      const q = qs(dataPath, {
        workspace: workspaceFromUrl || undefined,
        all: allSessions ? "true" : undefined,
        limit: allSessions ? undefined : String(limit),
      });
      return apiGet<{ ok: boolean; sessions: SessionSummary[] }>(
        `/api/cursor-history/sessions${q}`
      );
    },
  });

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
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-[var(--fg)]">Cursor 对话</h1>
        <p className="text-sm text-[var(--muted)] mt-1">
          读取本机 Cursor workspaceStorage 中的会话；若 Cursor 正在运行且数据库被占用，列表可能暂时失败（503）。
        </p>
      </div>

      {status.isError && (
        <div className="rounded border border-red-200 bg-red-50 text-red-800 text-sm p-3">
          {(status.error as Error).message}
        </div>
      )}

      {status.data && (
        <div className="text-sm text-[var(--muted)] space-y-1 rounded border border-[var(--border)] p-3 bg-white">
          <div>
            <span className="text-[var(--fg)] font-medium">数据目录：</span>
            {status.data.workspaceStorage}
          </div>
          <div>
            平台 {status.data.platform}
            {status.data.envCursorDataPath ? " · 已使用 CURSOR_DATA_PATH" : ""}
          </div>
        </div>
      )}

      <section className="space-y-3">
        <button
          type="button"
          className="text-sm text-[var(--accent)] hover:underline"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? "收起" : "展开"} 高级：自定义 data 路径
        </button>
        {showAdvanced && (
          <div className="flex flex-wrap gap-2 items-end">
            <label className="flex flex-col gap-1 text-sm min-w-[16rem] flex-1">
              <span className="text-[var(--muted)]">CURSOR_DATA_PATH 覆盖</span>
              <input
                className="rounded border border-[var(--border)] px-2 py-1 font-mono text-xs"
                value={dataPathDraft}
                onChange={(e) => setDataPathDraft(e.target.value)}
                placeholder="留空则用默认"
              />
            </label>
          </div>
        )}

        <div className="flex flex-wrap gap-3 items-end">
          <label className="flex flex-col gap-1 text-sm min-w-[14rem] flex-1">
            <span className="text-[var(--muted)]">按工作区过滤（路径子串或完整路径）</span>
            <input
              className="rounded border border-[var(--border)] px-2 py-1 text-sm"
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
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allSessions}
              onChange={(e) => setAllSessions(e.target.checked)}
            />
            列出全部（可能较慢）
          </label>
          {!allSessions && (
            <label className="flex flex-col gap-1 text-sm w-24">
              <span className="text-[var(--muted)]">条数</span>
              <input
                type="number"
                min={1}
                max={500}
                className="rounded border border-[var(--border)] px-2 py-1"
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value) || 50)}
              />
            </label>
          )}
          <button
            type="button"
            className="rounded bg-[var(--accent)] text-white px-3 py-1.5 text-sm"
            onClick={applyFilters}
          >
            应用
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">搜索会话</h2>
        <form onSubmit={runSearch} className="flex gap-2 flex-wrap">
          <input
            className="rounded border border-[var(--border)] px-2 py-1 text-sm flex-1 min-w-[12rem]"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="关键词…"
          />
          <button
            type="submit"
            className="rounded bg-[var(--accent)] text-white px-3 py-1 text-sm"
          >
            搜索
          </button>
        </form>
        {search.isError && (
          <p className="text-sm text-red-600">{(search.error as Error).message}</p>
        )}
        {search.data && search.data.results.length === 0 && (
          <p className="text-sm text-[var(--muted)]">无匹配</p>
        )}
        {search.data && search.data.results.length > 0 && (
          <ul className="space-y-2 text-sm border border-[var(--border)] rounded-md divide-y divide-[var(--border)] bg-white">
            {search.data.results.map((r) => (
              <li key={`${r.sessionId}-${r.index}`} className="p-3">
                <div className="flex flex-wrap gap-2 items-baseline">
                  <Link
                    className="text-[var(--accent)] hover:underline font-medium"
                    to={sessionLink(r.sessionId)}
                  >
                    会话 {r.sessionId.slice(0, 8)}…
                  </Link>
                  <span className="text-[var(--muted)]">
                    {r.matchCount} 处匹配 · index {r.index}
                  </span>
                </div>
                {r.snippets.slice(0, 3).map((s, i) => (
                  <pre
                    key={i}
                    className="mt-2 text-xs bg-neutral-50 p-2 rounded whitespace-pre-wrap break-words"
                  >
                    {s}
                  </pre>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">最近会话</h2>
        {sessions.isLoading && (
          <p className="text-sm text-[var(--muted)]">加载中…</p>
        )}
        {sessions.isError && (
          <p className="text-sm text-red-600">{(sessions.error as Error).message}</p>
        )}
        {sessions.data && (
          <ul className="space-y-1 border border-[var(--border)] rounded-md bg-white">
            {sessions.data.sessions.map((s) => (
              <li
                key={s.id}
                className="border-b border-[var(--border)] last:border-0 p-3 hover:bg-neutral-50"
              >
                <Link
                  to={sessionLink(s.id)}
                  className="text-[var(--accent)] hover:underline font-medium block"
                >
                  {s.title?.trim() || "（无标题）"}
                </Link>
                <div className="text-xs text-[var(--muted)] mt-1 space-x-2">
                  <span>{s.messageCount} 条消息</span>
                  <span>·</span>
                  <span>{formatFileTimeMs(new Date(s.lastUpdatedAt).getTime())}</span>
                  {s.workspacePath && (
                    <>
                      <span>·</span>
                      <span className="font-mono truncate max-w-full inline-block align-bottom">
                        {s.workspacePath}
                      </span>
                    </>
                  )}
                </div>
                {s.preview && (
                  <p className="text-xs text-[var(--muted)] mt-2 line-clamp-2">
                    {s.preview}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
