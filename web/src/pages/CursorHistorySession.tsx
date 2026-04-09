import { useQuery } from "@tanstack/react-query";
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
  metadata?: { corrupted?: boolean; bubbleType?: number };
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

function listQuery(dataPath: string): string {
  if (!dataPath.trim()) return "";
  return `?${new URLSearchParams({ dataPath: dataPath.trim() }).toString()}`;
}

function looksLikeJsonObject(s: string): boolean {
  const t = s.trim();
  return t.startsWith("{") && t.endsWith("}");
}

export function CursorHistorySession() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [searchParams] = useSearchParams();
  const dataPath = searchParams.get("dataPath") ?? "";
  const id = sessionId ?? "";
  const suffix = listQuery(dataPath);

  const session = useQuery({
    queryKey: ["cursor-history-session", id, dataPath],
    queryFn: () =>
      apiGet<{ ok: boolean; session: SessionDetail }>(
        `/api/cursor-history/sessions/${encodeURIComponent(id)}${suffix}`
      ),
    enabled: id.length > 0,
  });

  const backTo = `/cursor-history${suffix}`;

  if (!id) {
    return (
      <p className="text-sm text-[var(--muted)]">
        缺少会话 id。返回 <Link to="/cursor-history">列表</Link>
      </p>
    );
  }

  if (session.isLoading) {
    return <p className="text-sm text-[var(--muted)]">加载会话…</p>;
  }

  if (session.isError) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-red-600">{(session.error as Error).message}</p>
        <Link className="text-[var(--accent)] text-sm hover:underline" to={backTo}>
          ← 返回列表
        </Link>
      </div>
    );
  }

  const s = session.data!.session;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3 items-start justify-between">
        <div>
          <Link
            className="text-sm text-[var(--accent)] hover:underline"
            to={backTo}
          >
            ← Cursor 对话列表
          </Link>
          <h1 className="text-xl font-semibold text-[var(--fg)] mt-2">
            {s.title?.trim() || "（无标题）"}
          </h1>
          <p className="text-sm text-[var(--muted)] mt-1 space-x-2">
            <span>{s.messageCount} 条</span>
            <span>·</span>
            <span>更新 {formatFileTimeMs(new Date(s.lastUpdatedAt).getTime())}</span>
            {s.source && (
              <>
                <span>·</span>
                <span>来源 {s.source}</span>
              </>
            )}
          </p>
          {s.workspacePath && (
            <p className="text-xs font-mono text-[var(--muted)] mt-2 break-all">
              {s.workspacePath}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-6">
        {s.messages.map((m, idx) => (
          <article
            key={m.id ?? `m-${idx}`}
            className={[
              "rounded-lg border p-4 bg-white",
              m.role === "user"
                ? "border-blue-200 border-l-4 border-l-blue-500"
                : "border-[var(--border)] border-l-4 border-l-emerald-600",
            ].join(" ")}
          >
            <header className="flex flex-wrap gap-2 items-baseline text-xs text-[var(--muted)] mb-3">
              <span className="font-semibold text-[var(--fg)] uppercase tracking-wide">
                {m.role}
              </span>
              <span>·</span>
              <span>{formatFileTimeMs(new Date(m.timestamp).getTime())}</span>
              {m.model && (
                <>
                  <span>·</span>
                  <span className="font-mono">{m.model}</span>
                </>
              )}
              {m.durationMs != null && (
                <>
                  <span>·</span>
                  <span>{m.durationMs} ms</span>
                </>
              )}
              {m.metadata?.corrupted && (
                <span className="text-amber-700">（数据可能损坏）</span>
              )}
            </header>

            {m.thinking != null && m.thinking.trim() !== "" && (
              <details className="mb-3 rounded border border-amber-200 bg-amber-50/80">
                <summary className="cursor-pointer text-sm px-3 py-2 text-amber-900">
                  推理 / thinking
                </summary>
                <div className="px-3 pb-3 border-t border-amber-200/80 pt-2">
                  {looksLikeJsonObject(m.thinking) ? (
                    <JsonHighlighted
                      className="text-xs max-h-80 overflow-auto rounded"
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
        ))}
      </div>
    </div>
  );
}
