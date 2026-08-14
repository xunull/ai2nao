import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { MessageText } from "../components/MessageText";
import { RenderedMarkdown } from "../components/RenderedMarkdown";
import { formatFileTimeMs } from "../util/formatDisplay";

type ToolCall = {
  name: string;
  status: "completed" | "cancelled" | "error";
  params?: Record<string, unknown>;
  result?: string;
  error?: string;
};

type ApiMessage = {
  id: string | null;
  role: string;
  content: string;
  timestamp: string;
  model?: string;
  thinking?: string;
  toolCalls?: ToolCall[];
};

type OpencodeMeta = {
  directory?: string;
  model?: string;
  agent?: string;
  archived?: boolean;
  tokensInput?: number;
  tokensOutput?: number;
  cost?: number;
};

type SessionDetail = {
  id: string;
  title: string | null;
  lastUpdatedAt: string;
  messageCount: number;
  workspacePath?: string;
  source?: string;
  metadata?: { opencode?: OpencodeMeta };
  messages: ApiMessage[];
};

function enc(s: string): string {
  return encodeURIComponent(s);
}

function qs(opencodeRoot: string): string {
  const p = new URLSearchParams();
  if (opencodeRoot.trim()) p.set("opencodeRoot", opencodeRoot.trim());
  const q = p.toString();
  return q ? `?${q}` : "";
}

function fmtTokens(n?: number): string {
  if (!n || n <= 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

const backLinkClass =
  "inline-flex items-center gap-1 text-sm font-medium text-blue-600 transition hover:text-blue-800";
const btnGhost =
  "inline-flex items-center justify-center rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm transition hover:border-blue-200 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500/20";

export function OpencodeHistorySession() {
  const queryClient = useQueryClient();
  const { sessionId } = useParams<{ sessionId: string }>();
  const [searchParams] = useSearchParams();
  const opencodeRoot = searchParams.get("opencodeRoot") ?? "";
  const id = sessionId ?? "";
  const apiUrl = `/api/opencode-history/sessions/${enc(id)}${qs(opencodeRoot)}`;
  const listHref = `/opencode-history${qs(opencodeRoot)}`;

  const session = useQuery({
    queryKey: ["opencode-history-session", id, opencodeRoot],
    queryFn: () => apiGet<{ ok: boolean; session: SessionDetail; warnings?: string[] }>(apiUrl),
    enabled: id.length > 0,
  });

  function refreshSession() {
    void queryClient.invalidateQueries({ queryKey: ["opencode-history-session", id, opencodeRoot] });
  }

  if (!id) {
    return (
      <div className="cursor-chat-root rounded-2xl border border-dashed border-neutral-200 bg-slate-50/50 px-6 py-12 text-center text-sm text-neutral-600">
        缺少会话 id。
        <Link className="ml-1 font-medium text-blue-600 hover:underline" to="/opencode-history">
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
          ← opencode 对话列表
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
  const oc = s.metadata?.opencode;
  const warnings = session.data?.warnings ?? [];

  return (
    <div className="cursor-chat-root">
      <header className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-3 border-b border-neutral-200/80 bg-[var(--bg)]/90 px-1 py-2.5 backdrop-blur-md sm:-mx-0">
        <Link className={backLinkClass} to={listHref}>
          ← opencode 对话列表
        </Link>
        <button type="button" className={btnGhost} onClick={() => refreshSession()}>
          刷新此会话
        </button>
      </header>

      <div className="mt-6 rounded-2xl border border-neutral-200/80 bg-white px-5 py-4 shadow-sm sm:px-6 sm:py-5">
        <div className="flex flex-wrap items-start gap-3">
          <h1 className="min-w-0 flex-1 text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
            {s.title?.trim() || "无标题会话"}
          </h1>
          {oc?.archived && (
            <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700">
              archived
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500">
          <span>{s.messageCount} 条消息</span>
          <span className="text-neutral-300">·</span>
          <span>更新 {formatFileTimeMs(new Date(s.lastUpdatedAt).getTime())}</span>
          {oc?.model && <span>· {oc.model}</span>}
          {oc?.agent && <span>· {oc.agent}</span>}
          {s.source && <span>· {s.source}</span>}
        </div>
        {oc && (oc.tokensInput || oc.tokensOutput || oc.cost) && (
          <div className="mt-4 grid gap-2 text-sm sm:grid-cols-3">
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="text-xs text-neutral-500">输入 token</div>
              <div className="font-semibold">{fmtTokens(oc.tokensInput)}</div>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="text-xs text-neutral-500">输出 token</div>
              <div className="font-semibold">{fmtTokens(oc.tokensOutput)}</div>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="text-xs text-neutral-500">花费</div>
              <div className="font-semibold">${(oc.cost ?? 0).toFixed(4)}</div>
            </div>
          </div>
        )}
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
                    "rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase",
                    isUser ? "bg-blue-100 text-blue-800" : "bg-emerald-50 text-emerald-800",
                  ].join(" ")}
                >
                  {m.role}
                </span>
                <span className="text-xs tabular-nums text-neutral-400">
                  {formatFileTimeMs(new Date(m.timestamp).getTime())}
                </span>
                {m.model && <span className="truncate font-mono text-[11px] text-neutral-500">{m.model}</span>}
              </header>

              {/* 思考(reasoning)折叠,默认收起，避免大块拖慢页面。 */}
              {m.thinking && (
                <details className="mb-3 rounded-lg border border-neutral-200 bg-neutral-50/80 px-3 py-2 text-sm">
                  <summary className="cursor-pointer select-none text-xs font-medium text-neutral-500">
                    思考过程
                  </summary>
                  <div className="mt-2 text-neutral-700">
                    <RenderedMarkdown text={m.thinking} />
                  </div>
                </details>
              )}

              {m.content && <MessageText role={m.role} text={m.content} />}

              {/* 工具调用折叠。 */}
              {m.toolCalls && m.toolCalls.length > 0 && (
                <div className="mt-3 space-y-2">
                  {m.toolCalls.map((t, i) => (
                    <details
                      key={`${t.name}-${i}`}
                      className={[
                        "rounded-lg border px-3 py-2 text-sm shadow-sm",
                        t.status === "error"
                          ? "border-red-200 bg-red-50 text-red-950"
                          : "border-neutral-200 bg-white text-neutral-800",
                      ].join(" ")}
                    >
                      <summary className="cursor-pointer select-none font-medium">
                        {t.status === "error" ? "失败工具" : "工具"} · {t.name}
                      </summary>
                      {t.params && (
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded bg-slate-50 px-2 py-1.5 font-mono text-[11px]">
                          {JSON.stringify(t.params, null, 2)}
                        </pre>
                      )}
                      {t.result && (
                        <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-slate-50 px-2 py-1.5 font-mono text-[11px]">
                          {t.result}
                        </pre>
                      )}
                      {t.error && <p className="mt-2 text-xs text-red-700">{t.error}</p>}
                    </details>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
