import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { JsonHighlighted } from "../components/JsonHighlighted";
import { MessageMarkdown } from "../components/MessageMarkdown";
import { formatFileTimeMs } from "../util/formatDisplay";
import {
  hasCommandInjection,
  parseUserMessage,
  type UserSegment,
} from "../util/parseUserMessage";
import { sgrParse, type SgrSpan } from "../util/sgrParse";

// 单条消息(与后端 messageToJson 序列化后的形状对齐;分页 ?cursor= 每页返回一组)。
// 渲染只用到下面这些字段(与旧整会话渲染完全一致,不引入 toolCalls 等新展示)。
type ApiMessage = {
  id: string | null;
  role: string;
  content: string;
  timestamp: string;
  thinking?: string;
  model?: string;
  durationMs?: number;
  metadata?: {
    corrupted?: boolean;
    bubbleType?: number;
    claudeEventType?: string;
    claudeAppendix?: boolean;
  };
};

// 详情页头部(?meta=1);Date 已在后端序列化为 ISO 字符串。
type MetaHeader = {
  messageCount: number;
  createdAt: string;
  lastUpdatedAt: string;
  firstUserText: string | null;
  title: string;
  preview: string;
  workspacePath: string;
  warnings: string[];
};

type MetaResp = { ok: boolean; header: MetaHeader };
type PageResp = {
  ok: boolean;
  messages: ApiMessage[];
  nextCursor: number | null;
  hasMore: boolean;
};

// 每页大小(与后端默认一致);maxPages 上限累计页数,数据层内存有界(DOM 由虚拟列表有界)。
const PAGE_LIMIT = 50;
const MAX_PAGES = 40;
// 虚拟列表未测量前的估算行高(首帧用,measureElement 量到真实高度后自动替换)。
const ROW_ESTIMATE = 180;

function enc(s: string): string {
  return encodeURIComponent(s);
}

function projectsRootQs(projectsRoot: string): string {
  const p = new URLSearchParams();
  if (projectsRoot.trim()) p.set("projectsRoot", projectsRoot.trim());
  const q = p.toString();
  return q ? `?${q}` : "";
}

function looksLikeJsonObject(s: string): boolean {
  const t = s.trim();
  return t.startsWith("{") && t.endsWith("}");
}

const backLinkClass =
  "inline-flex items-center gap-1 text-sm font-medium text-blue-600 transition hover:text-blue-800";

const btnGhost =
  "inline-flex items-center justify-center rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm transition hover:border-blue-200 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500/20";

// SGR 色名 → Tailwind 文本/背景类(有限调色板,不放任意 rgb)。
const FG_CLASS: Record<string, string> = {
  black: "text-neutral-800", red: "text-red-600", green: "text-green-600",
  yellow: "text-yellow-600", blue: "text-blue-600", magenta: "text-fuchsia-600",
  cyan: "text-cyan-600", white: "text-neutral-500",
  "bright-black": "text-neutral-600", "bright-red": "text-red-500",
  "bright-green": "text-green-500", "bright-yellow": "text-amber-500",
  "bright-blue": "text-blue-500", "bright-magenta": "text-fuchsia-500",
  "bright-cyan": "text-cyan-500", "bright-white": "text-neutral-700",
};
const BG_CLASS: Record<string, string> = {
  black: "bg-neutral-200", red: "bg-red-100", green: "bg-green-100",
  yellow: "bg-yellow-100", blue: "bg-blue-100", magenta: "bg-fuchsia-100",
  cyan: "bg-cyan-100", white: "bg-neutral-100",
  "bright-black": "bg-neutral-300", "bright-red": "bg-red-200",
  "bright-green": "bg-green-200", "bright-yellow": "bg-amber-200",
  "bright-blue": "bg-blue-200", "bright-magenta": "bg-fuchsia-200",
  "bright-cyan": "bg-cyan-200", "bright-white": "bg-neutral-200",
};

// 海量 span 上限守卫(codex #8):高频 SGR(逐字上色)会炸 DOM,超限降级纯文本。
const MAX_SGR_SPANS = 1500;

function spanClass(s: SgrSpan): string {
  const cls: string[] = [];
  if (s.bold) cls.push("font-bold");
  if (s.italic) cls.push("italic");
  if (s.underline) cls.push("underline");
  if (s.fg && FG_CLASS[s.fg]) cls.push(FG_CLASS[s.fg]);
  if (s.bg && BG_CLASS[s.bg]) cls.push(BG_CLASS[s.bg]);
  return cls.join(" ");
}

/**
 * 命令输出块:等宽深底,SGR 残骸解析成样式 span。
 * 安全边界(codex #11):内容一律作**文本**(span 的 children 是纯字符串,不走
 * MessageMarkdown / dangerouslySetInnerHTML),user 消息含任意内容也不扩大 XSS 面。
 */
function TerminalOutput({ raw }: { raw: string }) {
  const spans = useMemo(() => sgrParse(raw), [raw]);
  const capped = spans.length > MAX_SGR_SPANS;
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-neutral-800/10 bg-neutral-900 px-3 py-2 font-mono text-xs leading-relaxed text-neutral-100">
      {capped
        ? spans.map((s) => s.text).join("")
        : spans.map((s, i) => {
            const cls = spanClass(s);
            return cls ? (
              <span key={i} className={cls}>
                {s.text}
              </span>
            ) : (
              <span key={i}>{s.text}</span>
            );
          })}
    </pre>
  );
}

// 斜杠命令 / bash 输入 → 徽标 chip + 参数。
function CommandChip({
  seg,
}: {
  seg: Extract<UserSegment, { kind: "command" }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="rounded-md bg-blue-100 px-2 py-0.5 font-mono text-xs font-semibold text-blue-800">
        {seg.name?.trim() || "命令"}
      </span>
      {seg.args && seg.args.trim() !== "" && (
        <span className="font-mono text-xs text-neutral-500">{seg.args}</span>
      )}
    </div>
  );
}

// caveat / system-reminder 样板 → 默认折叠。
function CaveatBlock({ text }: { text: string }) {
  return (
    <details className="overflow-hidden rounded-lg border border-neutral-200 bg-slate-50/60">
      <summary className="cursor-pointer select-none px-3 py-1.5 text-[11px] font-medium text-neutral-500 hover:bg-slate-100">
        系统注入样板(点开查看)
      </summary>
      <div className="whitespace-pre-wrap break-words border-t border-neutral-200/70 px-3 py-2 font-mono text-[11px] text-neutral-500">
        {text}
      </div>
    </details>
  );
}

// 单段派发。text 段走既有 MessageMarkdown(真人正文,信任路径);其余是结构化注入回显。
function UserSegmentView({ seg }: { seg: UserSegment }) {
  if (seg.kind === "command") return <CommandChip seg={seg} />;
  if (seg.kind === "stdout") return <TerminalOutput raw={seg.raw} />;
  if (seg.kind === "caveat") return <CaveatBlock text={seg.text} />;
  return <MessageMarkdown text={seg.text} />;
}

/**
 * 单条消息卡片——完全沿用旧整会话渲染的每条行 markup(不重新设计气泡):
 * 角色徽标 / appendix 事件徽标 / 时间 / 模型 / 损坏徽标 + 可展开 thinking + 正文。
 *
 * user 消息若含命令注入回显(斜杠/! 命令的标签+SGR 残骸),按段结构化渲染,并给一个
 * 「查看原文」切换看原始 payload(数据工作台排查用)。其余照旧走 MessageMarkdown。
 */
function MessageArticle({ m }: { m: ApiMessage }) {
  const isUser = m.role === "user";
  // 解析按 m.content key(codex #1:本 repo 回溯改写老行,同 id 内容会变,按 id 会陈旧)。
  const segments = useMemo<UserSegment[] | null>(
    () => (isUser && hasCommandInjection(m.content) ? parseUserMessage(m.content) : null),
    [isUser, m.content]
  );
  const [showRaw, setShowRaw] = useState(false);
  // 虚拟列表同一 DOM 槽会换消息;内容变了把「看原文」重置回结构化视图。
  useEffect(() => setShowRaw(false), [m.content]);
  return (
    <article
      className={[
        "rounded-2xl px-4 py-4 shadow-sm sm:px-5 sm:py-5",
        isUser
          ? "border border-blue-200/70 bg-blue-50/70"
          : "border border-neutral-100 bg-white ring-1 ring-black/[0.04]",
      ].join(" ")}
    >
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <span
          className={[
            "rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
            isUser ? "bg-blue-100 text-blue-800" : "bg-emerald-50 text-emerald-800",
          ].join(" ")}
        >
          {m.role}
        </span>
        {m.metadata?.claudeAppendix && (
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-900">
            {m.metadata.claudeEventType ?? "event"}
          </span>
        )}
        <span className="text-xs tabular-nums text-neutral-400">
          {formatFileTimeMs(new Date(m.timestamp).getTime())}
        </span>
        {m.model && (
          <span className="truncate font-mono text-[11px] text-neutral-500">
            {m.model}
          </span>
        )}
        {m.metadata?.corrupted && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900">
            数据可能损坏
          </span>
        )}
      </header>

      {m.thinking != null && m.thinking.trim() !== "" && (
        <details className="mb-4 overflow-hidden rounded-xl border border-amber-200/80 bg-amber-50/60">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-amber-950 hover:bg-amber-50">
            推理 / thinking
          </summary>
          <div className="border-t border-amber-200/60 px-4 py-3">
            {looksLikeJsonObject(m.thinking) ? (
              <JsonHighlighted
                className="max-h-80 overflow-auto rounded-lg text-xs"
                code={m.thinking}
              />
            ) : (
              <MessageMarkdown text={m.thinking} />
            )}
          </div>
        </details>
      )}

      {segments ? (
        <div>
          {showRaw ? (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-600">
              {m.content}
            </pre>
          ) : (
            <div className="space-y-2">
              {segments.map((seg, i) => (
                <UserSegmentView key={i} seg={seg} />
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            className="mt-2 text-[11px] font-medium text-neutral-400 transition hover:text-blue-600"
          >
            {showRaw ? "← 结构化视图" : "查看原文"}
          </button>
        </div>
      ) : (
        <MessageMarkdown text={m.content} />
      )}
    </article>
  );
}

/**
 * 消息虚拟列表:@tanstack/react-virtual + measureElement 自动测量。
 * - 滚动容器是 parentRef 这个 div(flex-1 填满剩余高度、内部纵向滚动、禁横向滚动)。
 * - 每行挂 virtualizer.measureElement,内建 ResizeObserver 自动量到真实高度并回填位置,
 *   无需手动 resetAfterIndex/行高缓存;内容变高(展开 thinking/details、正文加载)会自动重排。
 * - 末尾多一行哨兵页脚(index === items.length):承载「加载中 / 已到末尾」,也是触底触发点。
 */
function MessageList({
  items,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  items: ApiMessage[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  // 末尾多一行哨兵页脚。
  const itemCount = items.length + 1;

  const virtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 6,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  const virtualItems = virtualizer.getVirtualItems();

  // 触底:最后一个已渲染的虚拟行(哨兵页脚 / 最末消息)进入可视区 → 拉下一页。
  useEffect(() => {
    const last = virtualItems.at(-1);
    if (!last) return;
    if (last.index >= items.length - 1 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [virtualItems, items.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div
      ref={parentRef}
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {virtualItems.map((virtualItem) => {
          const isFooter = virtualItem.index >= items.length;
          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <div className="px-1 pb-5">
                {isFooter ? (
                  <div className="py-6 text-center text-xs text-neutral-400">
                    {isFetchingNextPage
                      ? "加载更多消息…"
                      : hasNextPage
                        ? "向下滚动加载更多"
                        : "已到对话末尾"}
                  </div>
                ) : (
                  <MessageArticle m={items[virtualItem.index]!} />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ClaudeCodeHistorySession() {
  const queryClient = useQueryClient();
  const { sessionId } = useParams<{ sessionId: string }>();
  const [searchParams] = useSearchParams();
  const projectsRoot = searchParams.get("projectsRoot") ?? "";
  const projectId = searchParams.get("projectId") ?? "";
  const id = sessionId ?? "";
  const enabled = id.length > 0 && projectId.length > 0;
  const baseUrl = `/api/claude-code-history/projects/${enc(projectId)}/sessions/${enc(id)}`;
  const rootQs = projectsRootQs(projectsRoot);

  // 头部:?meta=1 触发后端一次性索引(大文件约 1~2s),据此显示「首次打开」加载态。
  const meta = useQuery({
    queryKey: ["claude-code-history-session-meta", id, projectsRoot, projectId],
    queryFn: () => apiGet<MetaResp>(`${baseUrl}?meta=1${rootQs ? `&${rootQs.slice(1)}` : ""}`),
    enabled,
  });

  // 消息:?cursor=&limit= 向后翻页(oldest→new)。maxPages 上限累计页(顶部会被淘汰,
  // 阅读是自上而下,可接受;淘汰致索引位移时各行会重测自愈)。
  const messages = useInfiniteQuery({
    queryKey: ["claude-code-history-session-page", id, projectsRoot, projectId],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      if (projectsRoot.trim()) p.set("projectsRoot", projectsRoot.trim());
      p.set("cursor", String(pageParam));
      p.set("limit", String(PAGE_LIMIT));
      return apiGet<PageResp>(`${baseUrl}?${p.toString()}`);
    },
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    maxPages: MAX_PAGES,
    enabled,
  });

  const listParams = new URLSearchParams();
  if (projectsRoot.trim()) listParams.set("projectsRoot", projectsRoot.trim());
  if (projectId.trim()) listParams.set("project", projectId.trim());
  const listHref = `/claude-code-history${listParams.toString() ? `?${listParams}` : ""}`;

  function refreshSession() {
    void queryClient.invalidateQueries({
      queryKey: ["claude-code-history-session-meta", id, projectsRoot, projectId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["claude-code-history-session-page", id, projectsRoot, projectId],
    });
  }

  if (!id || !projectId) {
    return (
      <div className="cursor-chat-root rounded-2xl border border-dashed border-neutral-200 bg-slate-50/50 px-6 py-12 text-center text-sm text-neutral-600">
        缺少会话 id 或 projectId。
        <Link className="ml-1 font-medium text-blue-600 hover:underline" to="/claude-code-history">
          返回列表
        </Link>
      </div>
    );
  }

  // 首次打开:等 ?meta=1(可能在为大文件建索引)。
  if (meta.isLoading) {
    return (
      <div className="cursor-chat-root space-y-4" aria-busy>
        <div className="flex items-center gap-3 text-sm text-neutral-600">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-blue-500" />
          <span>加载会话… 正在为大文件建立索引</span>
        </div>
        <div className="h-28 animate-pulse rounded-2xl bg-neutral-100" />
        <div className="h-40 animate-pulse rounded-2xl bg-neutral-100" />
      </div>
    );
  }

  if (meta.isError) {
    return (
      <div className="cursor-chat-root space-y-4">
        <Link className={backLinkClass} to={listHref}>
          ← Claude Code 对话列表
        </Link>
        <div
          className="rounded-2xl border border-red-200/80 bg-red-50/90 px-4 py-3 text-sm text-red-900"
          role="alert"
        >
          {(meta.error as Error).message}
        </div>
      </div>
    );
  }

  const header = meta.data!.header;
  const warnings = header.warnings ?? [];
  const items = messages.data?.pages.flatMap((p) => p.messages) ?? [];
  const messagesReady = messages.isSuccess;
  const isEmpty = messagesReady && items.length === 0 && !messages.hasNextPage;

  return (
    <div className="cursor-chat-root flex h-[calc(100vh-2.5rem)] flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-neutral-200/80 pb-2.5">
        <Link className={backLinkClass} to={listHref}>
          ← Claude Code 对话列表
        </Link>
        <button type="button" className={btnGhost} onClick={() => refreshSession()}>
          刷新此会话
        </button>
      </header>

      <div className="mt-4 rounded-2xl border border-neutral-200/80 bg-white px-5 py-4 shadow-sm sm:px-6 sm:py-5">
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
          {header.title?.trim() || "无标题会话"}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500">
          <span>{header.messageCount} 条消息</span>
          <span className="text-neutral-300">·</span>
          <span>创建 {formatFileTimeMs(new Date(header.createdAt).getTime())}</span>
          <span className="text-neutral-300">·</span>
          <span>更新 {formatFileTimeMs(new Date(header.lastUpdatedAt).getTime())}</span>
        </div>
        {warnings.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-amber-900">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {header.workspacePath && (
          <p className="mt-3 break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-600">
            {header.workspacePath}
          </p>
        )}
      </div>

      <div className="mt-4 flex min-h-0 flex-1 flex-col">
        {messages.isLoading && (
          <div className="flex items-center gap-2 text-sm text-neutral-500">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-blue-500" />
            加载消息…
          </div>
        )}
        {messages.isError && (
          <div
            className="rounded-2xl border border-red-200/80 bg-red-50/90 px-4 py-3 text-sm text-red-900"
            role="alert"
          >
            {(messages.error as Error).message}
          </div>
        )}
        {isEmpty && (
          <div className="rounded-xl border border-dashed border-neutral-200 py-12 text-center text-sm text-neutral-500">
            此会话没有可展示的消息
          </div>
        )}
        {messagesReady && items.length > 0 && (
          <MessageList
            items={items}
            hasNextPage={Boolean(messages.hasNextPage)}
            isFetchingNextPage={messages.isFetchingNextPage}
            fetchNextPage={() => void messages.fetchNextPage()}
          />
        )}
      </div>
    </div>
  );
}
