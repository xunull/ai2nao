import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api";
import { formatFileTimeMs } from "../util/formatDisplay";
import { MessageMarkdown } from "./MessageMarkdown";
import { Sheet } from "./Sheet";

type MyMessage = { id: string | null; timestamp: string; text: string };
type MyMessagesResp = { ok: boolean; messages: MyMessage[]; cleanTitle: string };

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
 * 单 session 抽屉:只显示「我」在这个会话里手动发出的消息。option C:清洗归后端 ——
 * 调专用端点 `/projects/:p/sessions/:s/my-messages`,拿到的已是后端过滤 role + 去注入
 * 后的 `{messages, cleanTitle}`,抽屉本身不再清洗、只负责显示。清洗口径与 agent_user_messages
 * ingest 同一份(src/claudeCodeHistory/myMessages.ts)。
 */
export function MyMessagesSheet({
  open,
  onOpenChange,
  projectId,
  sessionId,
  projectsRoot,
}: Props) {
  const detail = useQuery({
    // 专用 my-messages 端点:后端已清洗(option C),前端只显示。
    queryKey: ["claude-my-messages", sessionId, projectsRoot, projectId],
    queryFn: () =>
      apiGet<MyMessagesResp>(
        `/api/claude-code-history/projects/${enc(projectId)}/sessions/${enc(
          sessionId
        )}/my-messages${projectsRootQs(projectsRoot)}`
      ),
    enabled: open && sessionId.length > 0 && projectId.length > 0,
  });

  const mine = detail.data?.messages ?? [];
  // 后端清洗后的标题(纯注入 → "")。
  const cleanTitle = detail.data?.cleanTitle ?? "";

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
