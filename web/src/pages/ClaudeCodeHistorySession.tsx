import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  VariableSizeList,
  type ListChildComponentProps,
  type ListOnItemsRenderedProps,
} from "react-window";
import { apiGet } from "../api";
import { JsonHighlighted } from "../components/JsonHighlighted";
import { MessageMarkdown } from "../components/MessageMarkdown";
import { formatFileTimeMs } from "../util/formatDisplay";

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

// 每页大小(与后端默认一致);maxPages 上限累计页数,数据层内存有界(DOM 由 react-window 有界)。
const PAGE_LIMIT = 50;
const MAX_PAGES = 40;
// 行高缓存未命中时的估算值(首帧用,measure 后立即被真实高度替换)。
const ROW_ESTIMATE = 180;
// 视口底部留白;列表高度 = 视口高 − 列表顶端 − 该留白。
const BOTTOM_GAP = 16;
// 列表最小高度(极端窄视口兜底,也是 jsdom 无布局时的下限)。
const MIN_LIST_HEIGHT = 240;

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

/**
 * 单条消息卡片——完全沿用旧整会话渲染的每条行 markup(不重新设计气泡):
 * 角色徽标 / appendix 事件徽标 / 时间 / 模型 / 损坏徽标 + 可展开 thinking + 正文 Markdown。
 */
function MessageArticle({ m }: { m: ApiMessage }) {
  const isUser = m.role === "user";
  return (
    <article
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

      <MessageMarkdown text={m.content} />
    </article>
  );
}

// 传给 react-window 每行的上下文(itemData)。
type RowData = {
  items: ApiMessage[];
  setSize: (index: number, size: number) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
};

/**
 * 虚拟列表的单行:最后一行(index === items.length)是页脚(加载中 / 到达开头提示),
 * 其余是消息卡片。用一个「测量包裹层」把行的真实自然高度上报给 setSize:
 * - useLayoutEffect 首次测量(offsetHeight,含 pb-5 的行间距);
 * - ResizeObserver 监听后续高度变化(如展开 thinking / details),再次上报 → resetAfterIndex。
 * 外层 div 用的是 react-window 传入的 style(绝对定位 + 由 itemSize 决定的高度);
 * 我们测量的是不受该高度约束的内层包裹层,拿到的是内容的自然高度。
 */
function VirtualRow({ index, style, data }: ListChildComponentProps<RowData>) {
  const { items, setSize, hasNextPage, isFetchingNextPage } = data;
  const rowRef = useRef<HTMLDivElement>(null);
  const isFooter = index >= items.length;
  const m = isFooter ? null : items[index];

  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const report = () => {
      const h = el.offsetHeight;
      if (h > 0) setSize(index, h);
    };
    report();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(report);
      ro.observe(el);
    }
    return () => ro?.disconnect();
    // 行内容变化(index 对应的消息 id 变了,如翻页顶部被淘汰致索引位移)时重测。
  }, [index, setSize, m?.id, isFooter]);

  return (
    <div style={style}>
      <div ref={rowRef} className="mx-auto max-w-3xl px-1 pb-5">
        {isFooter ? (
          <div className="py-6 text-center text-xs text-neutral-400">
            {isFetchingNextPage
              ? "加载更多消息…"
              : hasNextPage
                ? "向下滚动加载更多"
                : "已到对话末尾"}
          </div>
        ) : (
          <MessageArticle m={m!} />
        )}
      </div>
    </div>
  );
}

/**
 * 测量「列表容器可用高度」= 视口高 − 列表顶端在视口中的 top − 底部留白。
 * 这样列表内部滚动、整页不再随消息增长(工作台布局)。deps 变化(头部渲染完成)时重测。
 * jsdom 无真实布局:innerHeight 默认 768、top 为 0 → 得到正高度,列表照样渲染(便于测试)。
 */
function useAvailableHeight(recomputeKey: unknown): [
  RefObject<HTMLDivElement | null>,
  number,
] {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(MIN_LIST_HEIGHT);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const recompute = () => {
      const top = el.getBoundingClientRect().top;
      const h = Math.floor(window.innerHeight - top - BOTTOM_GAP);
      setHeight(Math.max(MIN_LIST_HEIGHT, h));
    };
    recompute();
    window.addEventListener("resize", recompute);
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      // 观察 body:头部高度变化(告警出现等)会改变列表 top,据此重算。
      ro = new ResizeObserver(recompute);
      ro.observe(document.body);
    }
    return () => {
      window.removeEventListener("resize", recompute);
      ro?.disconnect();
    };
  }, [recomputeKey]);
  return [ref, height];
}

/**
 * 消息虚拟列表:VariableSizeList + 行高缓存(Map<index,height>)。
 * - itemSize 读缓存,未命中回退 ROW_ESTIMATE;某行真实高度变化 → resetAfterIndex 重排。
 * - onItemsRendered 里 visibleStopIndex 逼近末尾时 fetchNextPage(哨兵页脚也在可视区内)。
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
  const listRef = useRef<VariableSizeList>(null);
  const sizeMap = useRef<Map<number, number>>(new Map());
  const [wrapRef, listHeight] = useAvailableHeight(items.length === 0);

  const setSize = useCallback((index: number, size: number) => {
    if (sizeMap.current.get(index) === size) return;
    sizeMap.current.set(index, size);
    listRef.current?.resetAfterIndex(index);
  }, []);

  const getSize = useCallback(
    (index: number) => sizeMap.current.get(index) ?? ROW_ESTIMATE,
    []
  );

  const onItemsRendered = useCallback(
    ({ visibleStopIndex }: ListOnItemsRenderedProps) => {
      if (hasNextPage && !isFetchingNextPage && visibleStopIndex >= items.length - 1) {
        fetchNextPage();
      }
    },
    [hasNextPage, isFetchingNextPage, items.length, fetchNextPage]
  );

  // 末尾多一行哨兵页脚:承载「加载中 / 已到末尾」并作为滚动触底的触发点。
  const itemCount = items.length + 1;
  const itemData: RowData = { items, setSize, hasNextPage, isFetchingNextPage };
  const listStyle: CSSProperties = { overflowX: "hidden" };

  return (
    <div ref={wrapRef} className="min-h-0 flex-1">
      <VariableSizeList
        ref={listRef}
        height={listHeight}
        width="100%"
        itemCount={itemCount}
        itemSize={getSize}
        estimatedItemSize={ROW_ESTIMATE}
        overscanCount={4}
        itemData={itemData}
        onItemsRendered={onItemsRendered}
        style={listStyle}
      >
        {VirtualRow}
      </VariableSizeList>
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
