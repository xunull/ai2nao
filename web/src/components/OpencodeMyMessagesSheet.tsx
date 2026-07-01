import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api";
import { formatFileTimeMs } from "../util/formatDisplay";
import { MessageMarkdown } from "./MessageMarkdown";
import { Sheet } from "./Sheet";

type MyMessage = { id: string; timestamp: string; text: string };

function enc(s: string): string {
  return encodeURIComponent(s);
}

function opencodeRootQs(opencodeRoot: string): string {
  const p = new URLSearchParams();
  if (opencodeRoot.trim()) p.set("opencodeRoot", opencodeRoot.trim());
  const q = p.toString();
  return q ? `?${q}` : "";
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  opencodeRoot: string;
  title: string;
};

/**
 * opencode 单 session 抽屉:尽量只显示「我手动输入」的内容。opencode/oh-my-opencode 的注入
 * 没有单一干净信号,清洗只能 best-effort(服务端已做:结构丢 + mode 块保守剥),斜杠命令展开
 * 仍可能残留 —— 故标题/空态文案**诚实**,不假装是纯手打。
 */
export function OpencodeMyMessagesSheet({
  open,
  onOpenChange,
  sessionId,
  opencodeRoot,
  title,
}: Props) {
  const q = useQuery({
    queryKey: ["opencode-history-my-messages", sessionId, opencodeRoot],
    queryFn: () =>
      apiGet<{ ok: boolean; messages: MyMessage[] }>(
        `/api/opencode-history/sessions/${enc(sessionId)}/my-messages${opencodeRootQs(opencodeRoot)}`
      ),
    enabled: open && sessionId.length > 0,
  });

  const mine = q.data?.messages ?? [];

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span>
          我的输入
          <span className="font-normal text-neutral-500">（已过滤注入）</span>
          {title.trim() ? (
            <span className="font-normal text-neutral-500"> · {title.trim()}</span>
          ) : null}
        </span>
      }
    >
      {q.isLoading ? (
        <p className="text-sm text-neutral-500">加载会话…</p>
      ) : q.isError ? (
        <p className="text-sm text-red-700" role="alert">
          {(q.error as Error).message}
        </p>
      ) : mine.length === 0 ? (
        <p className="text-sm text-neutral-500">
          未检测到可安全归类为手动输入的文本；已过滤 opencode / 编辑器 / 插件注入内容。
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-neutral-500">你发了 {mine.length} 条（best-effort，可能含斜杠命令展开）</p>
          <ol className="space-y-3">
            {mine.map((m, i) => {
              const t = new Date(m.timestamp).getTime();
              return (
                <li
                  key={m.id || i}
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
