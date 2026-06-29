import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api";
import { cleanUserMessage } from "../lib/cleanUserMessage";
import { formatFileTimeMs } from "../util/formatDisplay";
import { MessageMarkdown } from "./MessageMarkdown";
import { Sheet } from "./Sheet";

type ApiMessage = {
  id: string | null;
  role: string;
  content: string;
  timestamp: string;
};

type SessionDetail = { messages: ApiMessage[] };

function enc(s: string): string {
  return encodeURIComponent(s);
}

function projectsRootQs(projectsRoot: string): string {
  const p = new URLSearchParams();
  if (projectsRoot.trim()) p.set("projectsRoot", projectsRoot.trim());
  const q = p.toString();
  return q ? `?${q}` : "";
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  sessionId: string;
  /** 必须带上 —— 详情接口按它解析,且 queryKey 要与详情页逐字对齐才共享缓存。 */
  projectsRoot: string;
  title: string;
};

/**
 * 单 session 抽屉:只显示「我」在这个会话里手动发出的消息。复用详情接口
 * （与详情页同一 queryKey → 共享缓存),前端过滤 `role:"user"` 后再用
 * `cleanUserMessage` 剥掉机器注入,剥完为空的轮丢弃、不计数。
 */
export function MyMessagesSheet({
  open,
  onOpenChange,
  projectId,
  sessionId,
  projectsRoot,
  title,
}: Props) {
  const detail = useQuery({
    // 与 ClaudeCodeHistorySession.tsx 的 key 逐字对齐(含 projectsRoot 维)。
    queryKey: ["claude-code-history-session", sessionId, projectsRoot, projectId],
    queryFn: () =>
      apiGet<{ ok: boolean; session: SessionDetail; warnings?: string[] }>(
        `/api/claude-code-history/projects/${enc(projectId)}/sessions/${enc(
          sessionId
        )}${projectsRootQs(projectsRoot)}`
      ),
    enabled: open && sessionId.length > 0 && projectId.length > 0,
  });

  const mine = (detail.data?.session.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) => ({ id: m.id, timestamp: m.timestamp, text: cleanUserMessage(m.content) }))
    .filter((m) => m.text.length > 0);

  // 标题用的是首条用户消息,可能本身就是注入(如 caveat 包裹),清洗后再显示;
  // 清洗后为空(纯注入)就只显示「只看我说的」,不挂脏后缀。
  const cleanTitle = cleanUserMessage(title);

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
