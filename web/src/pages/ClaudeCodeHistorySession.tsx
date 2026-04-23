import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { JsonHighlighted } from "../components/JsonHighlighted";
import { MessageMarkdown } from "../components/MessageMarkdown";
import { formatFileTimeMs } from "../util/formatDisplay";

type ApiMessage = {
  id: string | null;
  role: string;
  content: string;
  timestamp: string;
  thinking?: string;
  model?: string;
  durationMs?: number;
  metadata?: {
    corrupted?: boolean;
    bubbleType?: number;
    claudeEventType?: string;
    claudeAppendix?: boolean;
  };
};

type SessionDetail = {
  id: string;
  index: number;
  title: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  messageCount: number;
  workspaceId: string;
  workspacePath?: string;
  source?: string;
  messages: ApiMessage[];
};

function enc(s: string): string {
  return encodeURIComponent(s);
}

function projectsRootQs(projectsRoot: string): string {
  const p = new URLSearchParams();
  if (projectsRoot.trim()) p.set("projectsRoot", projectsRoot.trim());
  const q = p.toString();
  return q ? `?${q}` : "";
}

function looksLikeJsonObject(s: string): boolean {
  const t = s.trim();
  return t.startsWith("{") && t.endsWith("}");
}

const backLinkClass =
  "inline-flex items-center gap-1 text-sm font-medium text-blue-600 transition hover:text-blue-800";

const btnGhost =
  "inline-flex items-center justify-center rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm transition hover:border-blue-200 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500/20";

export function ClaudeCodeHistorySession() {
  const queryClient = useQueryClient();
  const { sessionId } = useParams<{ sessionId: string }>();
  const [searchParams] = useSearchParams();
  const projectsRoot = searchParams.get("projectsRoot") ?? "";
  const projectId = searchParams.get("projectId") ?? "";
  const id = sessionId ?? "";
  const apiUrl = `/api/claude-code-history/projects/${enc(projectId)}/sessions/${enc(id)}${projectsRootQs(projectsRoot)}`;

  const session = useQuery({
    queryKey: ["claude-code-history-session", id, projectsRoot, projectId],
    queryFn: () =>
      apiGet<{ ok: boolean; session: SessionDetail; warnings?: string[] }>(
        apiUrl
      ),
    enabled: id.length > 0 && projectId.length > 0,
  });

  const listParams = new URLSearchParams();
  if (projectsRoot.trim()) listParams.set("projectsRoot", projectsRoot.trim());
  if (projectId.trim()) listParams.set("project", projectId.trim());
  const listHref = `/claude-code-history${listParams.toString() ? `?${listParams}` : ""}`;

  function refreshSession() {
    void queryClient.invalidateQueries({
      queryKey: ["claude-code-history-session", id, projectsRoot, projectId],
    });
  }

  if (!id || !projectId) {
    return (
      <div className="cursor-chat-root rounded-2xl border border-dashed border-neutral-200 bg-slate-50/50 px-6 py-12 text-center text-sm text-neutral-600">
        缺少会话 id 或 projectId。
        <Link className="ml-1 font-medium text-blue-600 hover:underline" to="/claude-code-history">
          返回列表
        </Link>
      </div>
    );
  }

  if (session.isLoading) {
    return (
      <div className="cursor-chat-root space-y-4 animate-pulse" aria-busy>
        <div className="h-10 w-48 rounded-lg bg-neutral-200" />
        <div className="h-28 rounded-2xl bg-neutral-100" />
        <div className="h-40 rounded-2xl bg-neutral-100" />
      </div>
    );
  }

  if (session.isError) {
    return (
      <div className="cursor-chat-root space-y-4">
        <Link className={backLinkClass} to={listHref}>
          ← Claude Code 对话列表
        </Link>
        <div
          className="rounded-2xl border border-red-200/80 bg-red-50/90 px-4 py-3 text-sm text-red-900"
          role="alert"
        >
          {(session.error as Error).message}
        </div>
      </div>
    );
  }

  const s = session.data!.session;
  const warnings = session.data?.warnings ?? [];

  return (
    <div className="cursor-chat-root">
      <header className="sticky top-0 z-10 -mx-1 border-b border-neutral-200/80 bg-[var(--bg)]/90 px-1 pb-4 pt-1 backdrop-blur-md sm:-mx-0">
        <div className="flex flex-wrap items-center gap-3">
          <Link className={backLinkClass} to={listHref}>
            ← Claude Code 对话列表
          </Link>
          <button type="button" className={btnGhost} onClick={() => refreshSession()}>
            刷新此会话
          </button>
        </div>
        <div className="mt-4 rounded-2xl border border-neutral-200/80 bg-white px-5 py-4 shadow-sm sm:px-6 sm:py-5">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
            {s.title?.trim() || "无标题会话"}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500">
            <span>{s.messageCount} 条消息</span>
            <span className="text-neutral-300">·</span>
            <span>更新 {formatFileTimeMs(new Date(s.lastUpdatedAt).getTime())}</span>
            {s.source && (
              <>
                <span className="text-neutral-300">·</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
                  {s.source}
                </span>
              </>
            )}
          </div>
          {warnings.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-amber-900">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {s.workspacePath && (
            <p className="mt-3 break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-600">
              {s.workspacePath}
            </p>
          )}
        </div>
      </header>

      <div className="mx-auto mt-8 max-w-3xl space-y-5 pb-16">
        {s.messages.length === 0 && (
          <div className="rounded-xl border border-dashed border-neutral-200 py-12 text-center text-sm text-neutral-500">
            此会话没有可展示的消息
          </div>
        )}
        {s.messages.map((m, idx) => {
          const isUser = m.role === "user";
          return (
            <article
              key={m.id ?? `m-${idx}`}
              className={[
                "rounded-2xl px-4 py-4 shadow-sm sm:px-5 sm:py-5",
                isUser
                  ? "ml-4 border border-slate-200/80 bg-slate-100/90 sm:ml-8"
                  : "mr-4 border border-neutral-100 bg-white ring-1 ring-black/[0.04] sm:mr-8",
              ].join(" ")}
            >
              <header className="mb-3 flex flex-wrap items-center gap-2">
                <span
                  className={[
                    "rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
                    isUser
                      ? "bg-blue-100 text-blue-800"
                      : "bg-emerald-50 text-emerald-800",
                  ].join(" ")}
                >
                  {m.role}
                </span>
                {m.metadata?.claudeAppendix && (
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-900">
                    {m.metadata.claudeEventType ?? "event"}
                  </span>
                )}
                <span className="text-xs tabular-nums text-neutral-400">
                  {formatFileTimeMs(new Date(m.timestamp).getTime())}
                </span>
                {m.model && (
                  <span className="truncate font-mono text-[11px] text-neutral-500">
                    {m.model}
                  </span>
                )}
                {m.metadata?.corrupted && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900">
                    数据可能损坏
                  </span>
                )}
              </header>

              {m.thinking != null && m.thinking.trim() !== "" && (
                <details className="mb-4 overflow-hidden rounded-xl border border-amber-200/80 bg-amber-50/60">
                  <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-amber-950 hover:bg-amber-50">
                    推理 / thinking
                  </summary>
                  <div className="border-t border-amber-200/60 px-4 py-3">
                    {looksLikeJsonObject(m.thinking) ? (
                      <JsonHighlighted
                        className="max-h-80 overflow-auto rounded-lg text-xs"
                        code={m.thinking}
                      />
                    ) : (
                      <MessageMarkdown text={m.thinking} />
                    )}
                  </div>
                </details>
              )}

              <MessageMarkdown text={m.content} />
            </article>
          );
        })}
      </div>
    </div>
  );
}
