import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api";
import { cleanCodexUserMessage } from "../lib/cleanCodexUserMessage";
import { formatFileTimeMs } from "../util/formatDisplay";
import { MessageMarkdown } from "./MessageMarkdown";
import { Sheet } from "./Sheet";

type ApiMessage = {
  id: string | null;
  role: string;
  content: string;
  timestamp: string;
  metadata?: { codexSource?: "event_msg" | "response_item" };
};

type SessionDetail = { messages: ApiMessage[] };

function enc(s: string): string {
  return encodeURIComponent(s);
}

function codexRootQs(codexRoot: string): string {
  const p = new URLSearchParams();
  if (codexRoot.trim()) p.set("codexRoot", codexRoot.trim());
  const q = p.toString();
  return q ? `?${q}` : "";
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  /** 详情接口按它解析;queryKey 也要与 CodexHistorySession 逐字对齐才共享缓存。 */
  codexRoot: string;
  title: string;
};

/**
 * 单 codex session 抽屉:只显示「我」在这个会话里真人手打的消息。复用 codex 详情接口
 * (与详情页同一 queryKey → 共享缓存)。codex 把每条 user 记两遍、且 AGENTS.md 注入也算
 * user,所以**先按 `metadata.codexSource==='event_msg'` 过滤**(干净的真人输入信号,自动
 * 排除 AGENTS.md + 双份),再用 `cleanCodexUserMessage` 丢掉 codex-exec 样板。
 */
export function CodexMyMessagesSheet({
  open,
  onOpenChange,
  sessionId,
  codexRoot,
  title,
}: Props) {
  const detail = useQuery({
    // 与 CodexHistorySession.tsx 的 key 逐字对齐(含 codexRoot 维)。
    queryKey: ["codex-history-session", sessionId, codexRoot],
    queryFn: () =>
      apiGet<{ ok: boolean; session: SessionDetail; warnings?: string[] }>(
        `/api/codex-history/sessions/${enc(sessionId)}${codexRootQs(codexRoot)}`
      ),
    enabled: open && sessionId.length > 0,
  });

  const mine = (detail.data?.session.messages ?? [])
    .filter((m) => m.role === "user" && m.metadata?.codexSource === "event_msg")
    .map((m) => ({ id: m.id, timestamp: m.timestamp, text: cleanCodexUserMessage(m.content) }))
    .filter((m) => m.text.length > 0);

  const cleanTitle = cleanCodexUserMessage(title);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span>
          只看我说的
          {cleanTitle ? (
            <span className="font-normal text-neutral-500"> · {cleanTitle}</span>
          ) : null}
        </span>
      }
    >
      {detail.isLoading ? (
        <p className="text-sm text-neutral-500">加载会话…</p>
      ) : detail.isError ? (
        <p className="text-sm text-red-700" role="alert">
          {(detail.error as Error).message}
        </p>
      ) : mine.length === 0 ? (
        <p className="text-sm text-neutral-500">这个会话里没有你手动发出的消息。</p>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-neutral-500">你发了 {mine.length} 条</p>
          <ol className="space-y-3">
            {mine.map((m, i) => {
              const t = new Date(m.timestamp).getTime();
              return (
                <li
                  key={m.id ?? i}
                  className="rounded-xl border border-neutral-200/80 bg-white px-4 py-3 shadow-sm"
                >
                  <div className="mb-1.5 flex items-center gap-2 text-[11px] text-neutral-400">
                    <span className="font-medium text-neutral-500">#{i + 1}</span>
                    {Number.isFinite(t) && (
                      <>
                        <span>·</span>
                        <span>{formatFileTimeMs(t)}</span>
                      </>
                    )}
                  </div>
                  <MessageMarkdown text={m.text} />
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </Sheet>
  );
}
