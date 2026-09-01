import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { apiGet } from "../api";
import { Page } from "../components/Page";
import { formatFileTimeMs } from "../util/formatDisplay";

/**
 * 单场 hermes 会话的正文。
 *
 * 与另外六家的详情页有一处本质不同:**内容主体在工具结果里,不在对话里**。
 * 真库 725 条 assistant 有 434 条正文为空(纯 tool_call 外壳),而 649 条 tool
 * 结果平均 1745 字。所以这里把工具结果当一等公民渲染(默认折起,点开看全文),
 * 而不是像别家那样只铺 user/assistant 两种气泡。
 *
 * assistant 的正文走三层回落(content → 推理 → 工具调用摘要),`textKind` 说明
 * 这一条的正文是哪一层来的 —— 后两层要标注出来,否则「AI 说的话」里混进推理
 * 和工具参数会让人以为模型在自言自语。
 */

type HermesToolCall = {
  callId: string;
  name: string;
  arguments: string;
  result: string | null;
};

type HermesMessage = {
  id: number;
  role: "user" | "assistant";
  eventAtIso: string;
  text: string;
  textKind: "content" | "reasoning" | "tool-calls";
  toolCalls: HermesToolCall[];
};

type HermesSession = {
  id: string;
  origin: "cron" | "cli" | "feishu" | "other";
  title: string;
  titleFallback: boolean;
  model: string | null;
  startedAtIso: string | null;
  endedAtIso: string | null;
  endReason: string | null;
  messageCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
};

type HermesDetailResponse = {
  detail: { session: HermesSession; messages: HermesMessage[]; metaSkipped: number } | null;
  diagnostic?: { kind: string; message: string };
};

const ORIGIN_LABEL: Record<HermesSession["origin"], string> = {
  cli: "命令行",
  feishu: "飞书",
  cron: "定时任务",
  other: "其他",
};

const KIND_NOTE: Record<HermesMessage["textKind"], string | null> = {
  content: null,
  reasoning: "模型的推理内容（这一条没有正式回复）",
  "tool-calls": "这一条只有工具调用，没有文字",
};

function parseTime(value: string | null): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function ToolCallBlock({ call }: { call: HermesToolCall }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
      >
        <span className="w-3 shrink-0 text-neutral-400">{open ? "▾" : "▸"}</span>
        <span className="shrink-0 font-mono font-medium text-teal-700">{call.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-500">
          {call.arguments}
        </span>
        {call.result === null && (
          <span className="shrink-0 text-[11px] text-amber-600">无结果</span>
        )}
      </button>
      {open && (
        <div className="border-t border-neutral-100 px-3 py-2">
          <div className="mb-1 text-[11px] font-medium text-neutral-400">参数</div>
          <pre className="mb-2 overflow-x-auto whitespace-pre-wrap break-words rounded bg-slate-50 px-2 py-1 text-[12px] text-neutral-700">
            {call.arguments || "（无）"}
          </pre>
          <div className="mb-1 text-[11px] font-medium text-neutral-400">结果</div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 px-2 py-1 text-[12px] text-neutral-700">
            {call.result ?? "（这次调用没有返回结果）"}
          </pre>
        </div>
      )}
    </div>
  );
}

export default function HermesHistorySession() {
  const { sessionId } = useParams<{ sessionId: string }>();

  const detail = useQuery({
    queryKey: ["hermes-history-session", sessionId],
    enabled: Boolean(sessionId),
    queryFn: () =>
      apiGet<HermesDetailResponse>(
        `/api/hermes-history/sessions/${encodeURIComponent(sessionId!)}`
      ),
  });

  const s = detail.data?.detail?.session;
  const messages = detail.data?.detail?.messages ?? [];
  const diagnostic = detail.data?.diagnostic;

  return (
    <Page
      title={s?.title || "Hermes 会话"}
      subtitle={s ? `${ORIGIN_LABEL[s.origin]} · ${s.id}` : undefined}
      fill
      actions={
        <Link
          to="/hermes-history"
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
      {diagnostic && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          读不到 Hermes 的 state.db（{diagnostic.kind}）：{diagnostic.message}
        </div>
      )}

      {s && (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
          <span>{messages.length} 条消息</span>
          <span className="text-neutral-300">·</span>
          <span>{s.toolCallCount} 次工具调用</span>
          {s.model && (
            <>
              <span className="text-neutral-300">·</span>
              <span>{s.model}</span>
            </>
          )}
          {s.endReason && (
            <>
              <span className="text-neutral-300">·</span>
              <span>结束于 {s.endReason}</span>
            </>
          )}
          <span className="text-neutral-300">·</span>
          <span>{formatFileTimeMs(parseTime(s.endedAtIso ?? s.startedAtIso))}</span>
          {s.titleFallback && (
            <>
              <span className="text-neutral-300">·</span>
              <span className="italic">标题是取首条提问兜底的，源库里没有</span>
            </>
          )}
        </div>
      )}

      {/* 固定视口 + 内部纵向滚动;禁横向滚动,长内容在自己的容器里横滚。 */}
      <div
        data-testid="hermes-session-scroll"
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-xl border border-neutral-200 bg-white px-5 py-4"
      >
        {detail.isLoading && (
          <div className="py-12 text-center text-sm text-neutral-500">加载中…</div>
        )}
        {!detail.isLoading && !diagnostic && messages.length === 0 && !detail.isError && (
          <div className="rounded-xl border border-dashed border-neutral-200 py-12 text-center text-sm text-neutral-500">
            这场会话没有可读的正文
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
                  {m.role === "user" ? "我" : "Hermes"}
                </span>
                <span>{formatFileTimeMs(parseTime(m.eventAtIso))}</span>
                {KIND_NOTE[m.textKind] && (
                  <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">
                    {KIND_NOTE[m.textKind]}
                  </span>
                )}
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-3 py-2 text-[13px] leading-relaxed text-neutral-800">
                {m.text}
              </pre>
              {m.toolCalls.length > 0 && (
                <div className="mt-1.5 space-y-1 pl-3">
                  {m.toolCalls.map((c) => (
                    <ToolCallBlock key={c.callId} call={c} />
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      </div>
    </Page>
  );
}
