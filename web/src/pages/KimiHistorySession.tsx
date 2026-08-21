import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { apiGet } from "../api";
import { Page } from "../components/Page";
import { formatFileTimeMs } from "../util/formatDisplay";

/**
 * 单场 kimi 会话的正文。
 *
 * 布局用 `Page fill` + 内部滚动:会话最长的一场有 303 条消息,一路堆到页面下面
 * 会违反「禁止垂直堆太多」的约束。不做虚拟列表 —— 300 个 DOM 节点不值得那份复杂度
 * (claude 那边的会话动辄上万条,才需要 react-virtual)。
 *
 * 正文的筛子是「AI 正文 + 真人提问」,排除 `<bash-input>` 这类结构上 role='user'
 * 但 is_human=0 的工具噪音。所以一场全是工具噪音的会话在这里是**空态**,
 * 与列表页的「提问 0」对得上 —— 而不是 404,那会让「没内容」看起来像「不存在」。
 */

type KimiSession = {
  sessionId: string;
  title: string | null;
  projectPath: string;
  model: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  agentCount: number;
  humanMessageCount: number;
  totalMessageCount: number;
};

type KimiMessage = {
  id: number;
  role: "user" | "assistant";
  eventAtUtc: string;
  text: string;
};

type KimiSessionResponse = {
  ok: true;
  session: KimiSession;
  messages: KimiMessage[];
};

function parseTime(value: string): number {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

export default function KimiHistorySession() {
  const { sessionId } = useParams<{ sessionId: string }>();

  const detail = useQuery({
    queryKey: ["kimi-history-session", sessionId],
    enabled: Boolean(sessionId),
    queryFn: () =>
      apiGet<KimiSessionResponse>(
        `/api/kimi-history/sessions/${encodeURIComponent(sessionId!)}`
      ),
  });

  const s = detail.data?.session;
  const messages = detail.data?.messages ?? [];

  return (
    <Page
      title={s?.title?.trim() || "Kimi 会话"}
      subtitle={s ? s.projectPath : undefined}
      fill
      actions={
        <Link
          to="/kimi-history"
          className="inline-flex h-9 items-center gap-1 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-800 shadow-sm transition hover:border-blue-200 hover:bg-slate-50"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          返回列表
        </Link>
      }
    >
      {detail.isError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {(detail.error as Error).message}
        </div>
      )}

      {s && (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
          <span>{s.agentCount} 个 agent</span>
          <span className="text-neutral-300">·</span>
          <span>问了 {s.humanMessageCount} 次</span>
          <span className="text-neutral-300">·</span>
          <span>共 {messages.length} 条正文</span>
          {s.model && (
            <>
              <span className="text-neutral-300">·</span>
              <span>{s.model}</span>
            </>
          )}
          <span className="text-neutral-300">·</span>
          <span>更新 {formatFileTimeMs(parseTime(s.lastUpdatedAt))}</span>
        </div>
      )}

      {/* 固定视口 + 内部纵向滚动;禁横向滚动,长代码块在自己的容器里横滚。 */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-xl border border-neutral-200 bg-white px-5 py-4">
        {detail.isLoading && (
          <div className="py-12 text-center text-sm text-neutral-500">加载中…</div>
        )}
        {!detail.isLoading && messages.length === 0 && !detail.isError && (
          <div className="rounded-xl border border-dashed border-neutral-200 py-12 text-center text-sm text-neutral-500">
            这场会话没有可读的正文
            <div className="mt-1 text-xs text-neutral-400">
              它的内容全是工具调用与系统事件，或者正文尚未入库。
            </div>
          </div>
        )}
        <div className="space-y-4">
          {messages.map((m) => (
            <article key={m.id} className="min-w-0">
              <div className="mb-1 flex items-center gap-2 text-[11px] text-neutral-400">
                <span
                  className={
                    m.role === "user"
                      ? "rounded-full bg-blue-50 px-2 py-0.5 font-medium text-blue-700"
                      : "rounded-full bg-neutral-100 px-2 py-0.5 font-medium text-neutral-600"
                  }
                >
                  {m.role === "user" ? "我" : "Kimi"}
                </span>
                <span>{formatFileTimeMs(parseTime(m.eventAtUtc))}</span>
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-3 py-2 text-[13px] leading-relaxed text-neutral-800">
                {m.text}
              </pre>
            </article>
          ))}
        </div>
      </div>
    </Page>
  );
}
