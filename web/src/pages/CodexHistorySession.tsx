import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { MessageMarkdown } from "../components/MessageMarkdown";
import { formatFileTimeMs } from "../util/formatDisplay";

type ApiMessage = {
  id: string | null;
  role: string;
  content: string;
  timestamp: string;
  model?: string;
  metadata?: {
    codexEventType?: string;
    codexToolEvent?: boolean;
    codexFailed?: boolean;
  };
};

type Metrics = {
  toolCallCount: number;
  commandCount: number;
  failedCommandCount: number;
  fileCount: number;
};

type SessionDetail = {
  id: string;
  title: string | null;
  lastUpdatedAt: string;
  messageCount: number;
  workspacePath?: string;
  source?: string;
  metadata?: {
    codex?: {
      cwd?: string;
      gitBranch?: string;
      model?: string;
      archived?: boolean;
      rolloutPath?: string;
      degraded?: boolean;
      degradationReason?: string;
      metrics?: Metrics;
    };
  };
  messages: ApiMessage[];
};

function enc(s: string): string {
  return encodeURIComponent(s);
}

function qs(codexRoot: string): string {
  const p = new URLSearchParams();
  if (codexRoot.trim()) p.set("codexRoot", codexRoot.trim());
  const q = p.toString();
  return q ? `?${q}` : "";
}

const backLinkClass =
  "inline-flex items-center gap-1 text-sm font-medium text-blue-600 transition hover:text-blue-800";

const btnGhost =
  "inline-flex items-center justify-center rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm transition hover:border-blue-200 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500/20";

export function CodexHistorySession() {
  const queryClient = useQueryClient();
  const { sessionId } = useParams<{ sessionId: string }>();
  const [searchParams] = useSearchParams();
  const codexRoot = searchParams.get("codexRoot") ?? "";
  const id = sessionId ?? "";
  const apiUrl = `/api/codex-history/sessions/${enc(id)}${qs(codexRoot)}`;
  const listHref = `/codex-history${qs(codexRoot)}`;

  const session = useQuery({
    queryKey: ["codex-history-session", id, codexRoot],
    queryFn: () =>
      apiGet<{ ok: boolean; session: SessionDetail; warnings?: string[]; metrics?: Metrics }>(
        apiUrl
      ),
    enabled: id.length > 0,
  });

  function refreshSession() {
    void queryClient.invalidateQueries({
      queryKey: ["codex-history-session", id, codexRoot],
    });
  }

  if (!id) {
    return (
      <div className="cursor-chat-root rounded-2xl border border-dashed border-neutral-200 bg-slate-50/50 px-6 py-12 text-center text-sm text-neutral-600">
        缺少会话 id。
        <Link className="ml-1 font-medium text-blue-600 hover:underline" to="/codex-history">
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
        <Link className={backLinkClass} to={listHref}>← Codex 对话列表</Link>
        <div className="rounded-2xl border border-red-200/80 bg-red-50/90 px-4 py-3 text-sm text-red-900" role="alert">
          {(session.error as Error).message}
        </div>
      </div>
    );
  }

  const s = session.data!.session;
  const codex = s.metadata?.codex;
  const metrics = session.data?.metrics ?? codex?.metrics;
  const warnings = session.data?.warnings ?? [];

  return (
    <div className="cursor-chat-root">
      <header className="sticky top-0 z-10 -mx-1 border-b border-neutral-200/80 bg-[var(--bg)]/90 px-1 pb-4 pt-1 backdrop-blur-md sm:-mx-0">
        <div className="flex flex-wrap items-center gap-3">
          <Link className={backLinkClass} to={listHref}>← Codex 对话列表</Link>
          <button type="button" className={btnGhost} onClick={() => refreshSession()}>
            刷新此会话
          </button>
        </div>
        <div className="mt-4 rounded-2xl border border-neutral-200/80 bg-white px-5 py-4 shadow-sm sm:px-6 sm:py-5">
          <div className="flex flex-wrap items-start gap-3">
            <h1 className="min-w-0 flex-1 text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
              {s.title?.trim() || "无标题会话"}
            </h1>
            {codex?.degraded && (
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-950">
                degraded · {codex.degradationReason}
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500">
            <span>{s.messageCount} 条消息</span>
            <span className="text-neutral-300">·</span>
            <span>更新 {formatFileTimeMs(new Date(s.lastUpdatedAt).getTime())}</span>
            {codex?.gitBranch && <span>· {codex.gitBranch}</span>}
            {codex?.model && <span>· {codex.model}</span>}
            {s.source && <span>· {s.source}</span>}
          </div>
          {metrics && (
            <div className="mt-4 grid gap-2 text-sm sm:grid-cols-4">
              <div className="rounded-lg bg-slate-50 px-3 py-2"><div className="text-xs text-neutral-500">工具调用</div><div className="font-semibold">{metrics.toolCallCount}</div></div>
              <div className="rounded-lg bg-slate-50 px-3 py-2"><div className="text-xs text-neutral-500">命令</div><div className="font-semibold">{metrics.commandCount}</div></div>
              <div className="rounded-lg bg-slate-50 px-3 py-2"><div className="text-xs text-neutral-500">失败命令</div><div className="font-semibold text-red-700">{metrics.failedCommandCount}</div></div>
              <div className="rounded-lg bg-slate-50 px-3 py-2"><div className="text-xs text-neutral-500">涉及文件</div><div className="font-semibold">{metrics.fileCount}</div></div>
            </div>
          )}
          {warnings.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-amber-900">
              {warnings.map((w) => <li key={w}>{w}</li>)}
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
          const isTool = Boolean(m.metadata?.codexToolEvent);
          const failed = Boolean(m.metadata?.codexFailed);
          if (isTool) {
            return (
              <details
                key={m.id ?? `m-${idx}`}
                className={[
                  "rounded-xl border px-4 py-3 text-sm shadow-sm",
                  failed ? "border-red-200 bg-red-50 text-red-950" : "border-neutral-200 bg-white text-neutral-800",
                ].join(" ")}
              >
                <summary className="cursor-pointer select-none font-medium">
                  {failed ? "失败工具事件" : "工具事件"} · {m.metadata?.codexEventType ?? "tool"} · {formatFileTimeMs(new Date(m.timestamp).getTime())}
                </summary>
                <pre className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-white/70 px-3 py-2 font-mono text-xs">
                  {m.content}
                </pre>
              </details>
            );
          }
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
                <span className={[
                  "rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase",
                  isUser ? "bg-blue-100 text-blue-800" : "bg-emerald-50 text-emerald-800",
                ].join(" ")}>
                  {m.role}
                </span>
                <span className="text-xs tabular-nums text-neutral-400">
                  {formatFileTimeMs(new Date(m.timestamp).getTime())}
                </span>
                {m.model && <span className="truncate font-mono text-[11px] text-neutral-500">{m.model}</span>}
              </header>
              <MessageMarkdown text={m.content} />
            </article>
          );
        })}
      </div>
    </div>
  );
}
