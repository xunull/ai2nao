import { useInfiniteQuery } from "@tanstack/react-query";
import { MessagePlainText } from "../components/MessagePlainText";
import { Sheet } from "../components/Sheet";
import { getAiChatSessionMessages } from "./sessionApi";

const ROLE_LABEL: Record<string, string> = {
  user: "你",
  assistant: "AI",
  tool: "工具结果",
  reasoning: "思考",
  system: "系统",
  developer: "开发者",
};

/**
 * 会话原文(含被压缩掉的轮次)。压缩只是不再发给模型,原文一条不少。
 *
 * **只在打开时挂载**(由调用方负责):`useInfiniteQuery` 即使 `enabled: false` 也要求
 * 外层有 `QueryClientProvider`,分隔线一挂就要它的话,凡是渲染对话页的地方都得多包一层。
 */
export function OriginalMessagesSheet({
  open,
  onOpenChange,
  sessionId,
  foldedIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  /** 当前生效压缩折叠掉的消息 id,打上「已压缩」标记。 */
  foldedIds: string[];
}) {
  const q = useInfiniteQuery({
    queryKey: ["ai-chat-original", sessionId],
    queryFn: ({ pageParam }) =>
      getAiChatSessionMessages(sessionId, { before: pageParam, limit: 50 }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
    enabled: open && sessionId.length > 0,
  });
  const folded = new Set(foldedIds);
  // 接口最新在前(keyset 往前翻);抽屉里按时间正序读,所以整体倒过来,「加载更早」放顶上。
  const rows = (q.data?.pages.flatMap((p) => p.messages) ?? []).slice().reverse();

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="会话原文">
      {q.isLoading ? (
        <p className="text-sm text-neutral-500">加载原文…</p>
      ) : q.isError ? (
        <p className="text-sm text-red-700" role="alert">
          {(q.error as Error).message}
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-neutral-500">
            压缩只是不再把消息发给模型,原文一条都没删。标「已压缩」的是当前压缩折叠掉的部分。
          </p>
          {q.hasNextPage ? (
            <button
              type="button"
              disabled={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
              className="text-xs underline text-neutral-600 disabled:opacity-40"
            >
              {q.isFetchingNextPage ? "加载中…" : "加载更早的消息"}
            </button>
          ) : null}
          <ol className="space-y-2">
            {rows.map((m) => (
              <li key={m.messageId} className="rounded-lg border border-neutral-200 px-3 py-2">
                <div className="mb-1 flex items-center gap-2 text-[11px] text-neutral-400">
                  <span className="font-medium text-neutral-500">{ROLE_LABEL[m.role] ?? m.role}</span>
                  {folded.has(m.messageId) ? <span className="text-amber-700">已压缩</span> : null}
                </div>
                <MessagePlainText text={m.text || m.preview} />
              </li>
            ))}
          </ol>
        </div>
      )}
    </Sheet>
  );
}
