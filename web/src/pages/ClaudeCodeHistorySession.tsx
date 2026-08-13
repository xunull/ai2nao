import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { extractJsonFence, parseSmartJson } from "../util/smartJson";
import { SmartJsonView } from "../components/SmartJsonView";
import {
  computeAnchorIndex,
  filterByReadingHidden,
  mergeAdjacentAssistant,
  type MergedCard,
} from "../util/conversationFilter";
import { ReadingModeToggle, useReadingMode } from "../components/ReadingModeToggle";
import { SortOrderToggle, useSortOrder, type SortOrder } from "../components/SortOrderToggle";
import { Toggle } from "../components/Toggle";
import { AskUserQuestionCard } from "../components/AskUserQuestionCard";

// 单条消息(与后端 messageToJson 序列化后的形状对齐;分页 ?cursor= 每页返回一组)。
type ApiMessage = {
  id: string | null;
  role: string;
  content: string;
  timestamp: string;
  thinking?: string;
  model?: string;
  durationMs?: number;
  toolCalls?: {
    id?: string;
    name: string;
    params?: Record<string, unknown>;
  }[];
  metadata?: {
    corrupted?: boolean;
    bubbleType?: number;
    claudeEventType?: string;
    claudeAppendix?: boolean;
    /** 阅读模式下为何隐藏;后端算,前端只读(口径见 src/claudeCodeHistory/normalize.ts)。 */
    readingHidden?: "appendix" | "tool-only" | "injected";
    /** AskUserQuestion 的作答:问题 → 选中项。 */
    answers?: Record<string, string>;
    /** 上面 answers 配给哪次 tool_use(对应 assistant 侧 toolCalls[].id)。 */
    answersForToolUseId?: string;
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
/**
 * 阅读模式下一页 50 条滤完只剩十几条可见(实测按字节丢弃 75%),一次触底填不满一屏。
 * 后端单页上限本来就是 200(load.ts MAX_PAGE_LIMIT),直接多拉一些 —— 比在前端搓
 * 「循环拉页直到够一屏」的状态机简单得多,也没有那个状态何时重置的问题。
 * maxPages 不跟着改:调小会让 react-query 立刻截断已加载的页,滚过的内容当场消失。
 */
const READING_PAGE_LIMIT = 200;
// 虚拟列表未测量前的估算行高(首帧用,measureElement 量到真实高度后自动替换)。
const ROW_ESTIMATE = 180;
/**
 * 切换开关后持续重新锚定的时间窗。切换会触发补拉新页,新页到达时的重排会把位置冲掉,
 * 所以要在这段时间内每次数据变化都重新对准。取 2s:够覆盖一两次本地接口往返,
 * 又不至于长到把用户之后的手动滚动也拽回来。
 */
const ANCHOR_HOLD_MS = 2000;

/**
 * 视口顶部那一项的下标。
 *
 * **不能用 getVirtualItems()[0]** —— 它包含 overscan(本页 6 行),即视口上方多渲染的那几行。
 * 列表滚到靠前位置时 overscan 会把下标压到 0,于是锚点被取成第一条消息、切换后跳回顶部。
 * 实测:阅读模式下 scrollTop=933、共约 20 张卡,视口顶部本是第 3 张,减 6 后 clamp 成 0。
 * 取第一个「底边越过 scrollTop」的项才是真正露在视口顶部的那张。
 */
function topVisibleIndex(v: Virtualizer<HTMLDivElement, Element>): number {
  const items = v.getVirtualItems();
  if (items.length === 0) return 0;
  const top = v.scrollElement?.scrollTop ?? 0;
  return (items.find((it) => it.end > top) ?? items[items.length - 1]!).index;
}

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
 * appendix 事件(hook/snapshot/attachment 等)正文:默认折叠成一个展开按钮。
 * 展开后**才** parse(懒解析,避免大量 appendix 挂载时一次性吃 CPU)→ SmartJsonView 智能 JSON
 * (递归解 JSON-in-string、长文本叶子显真实换行)。「查看原文」切回原始 ```json fence。
 * 解析失败(半截 JSON / 超限)→ 降级回既有 Markdown/Prism,绝不空白。
 */
function AppendixBody({ content, expandDefault }: { content: string; expandDefault: boolean }) {
  // 初值取全局默认:虚拟列表里新滚进来的块挂载即读它 → 步入视口自动展开(开关开时)。
  const [expanded, setExpanded] = useState(expandDefault);
  const [showRaw, setShowRaw] = useState(false);
  // 全局开关翻转 → 已挂载的块跟随新默认(单块手动开合在下次翻转前保留)。
  useEffect(() => setExpanded(expandDefault), [expandDefault]);
  const node = useMemo(
    () => (expanded && !showRaw ? parseSmartJson(extractJsonFence(content) ?? content) : null),
    [expanded, showRaw, content]
  );
  const approxKb = Math.max(1, Math.round(content.length / 1024));

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="text-xs font-medium text-blue-600 transition hover:text-blue-800"
      >
        展开查看结构化内容(约 {approxKb} KB)
      </button>
    );
  }
  return (
    <div>
      {showRaw || node === null ? (
        // 原文视图 / 解析失败降级:回既有 Prism 渲染,不空白。
        <MessageMarkdown text={content} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-100 bg-slate-50/40 p-3">
          <SmartJsonView node={node} />
        </div>
      )}
      <div className="mt-2 flex gap-3 text-[11px] text-neutral-400">
        <button type="button" onClick={() => setExpanded(false)} className="transition hover:text-blue-600">
          收起
        </button>
        {node !== null && (
          <button type="button" onClick={() => setShowRaw((v) => !v)} className="transition hover:text-blue-600">
            {showRaw ? "← 结构化视图" : "查看原文"}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 单条消息卡片——完全沿用旧整会话渲染的每条行 markup(不重新设计气泡):
 * 角色徽标 / appendix 事件徽标 / 时间 / 模型 / 损坏徽标 + 可展开 thinking + 正文。
 *
 * user 消息若含命令注入回显(斜杠/! 命令的标签+SGR 残骸),按段结构化渲染,并给一个
 * 「查看原文」切换看原始 payload(数据工作台排查用)。其余照旧走 MessageMarkdown。
 */
/**
 * 一条消息的正文(不含卡片外壳与 header)。抽出来是因为阅读模式会把同一轮的多条
 * assistant 消息并进一张卡,而每段各自要保有 thinking 折叠、「查看原文」这些状态 ——
 * 放在同一个组件里就得在循环里用 hooks。
 */
function MessageBody({
  m,
  expandAppendix,
  readingMode,
  answersByToolUseId,
}: {
  m: ApiMessage;
  expandAppendix: boolean;
  readingMode: boolean;
  answersByToolUseId: Record<string, Record<string, string>>;
}) {
  const isUser = m.role === "user";
  // 只在阅读模式下渲染提问卡:关闭开关时页面输出与改动前保持一致(不引入新展示)。
  const asks = readingMode
    ? (m.toolCalls ?? []).filter((t) => t.name === "AskUserQuestion")
    : [];
  // 解析按 m.content key(codex #1:本 repo 回溯改写老行,同 id 内容会变,按 id 会陈旧)。
  const segments = useMemo<UserSegment[] | null>(
    () => (isUser && hasCommandInjection(m.content) ? parseUserMessage(m.content) : null),
    [isUser, m.content]
  );
  const [showRaw, setShowRaw] = useState(false);
  // 虚拟列表同一 DOM 槽会换消息;内容变了把「看原文」重置回结构化视图。
  useEffect(() => setShowRaw(false), [m.content]);
  return (
    <>
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
      ) : m.metadata?.claudeAppendix ? (
        <AppendixBody content={m.content} expandDefault={expandAppendix} />
      ) : (
        <MessageMarkdown text={m.content} />
      )}

      {asks.map((t, i) => (
        <AskUserQuestionCard
          key={t.id ?? i}
          params={t.params}
          answers={t.id ? answersByToolUseId[t.id] : undefined}
        />
      ))}
    </>
  );
}

/**
 * 一张消息卡。非阅读模式下一卡一条(与改动前渲染完全一致);阅读模式下同一轮被 jsonl
 * 拆开的多条 assistant 消息会并进同一张卡,header 取首条,正文按序依次排。
 */
function MessageArticle({
  card,
  expandAppendix,
  readingMode,
  answersByToolUseId,
}: {
  card: MergedCard<ApiMessage>;
  expandAppendix: boolean;
  readingMode: boolean;
  answersByToolUseId: Record<string, Record<string, string>>;
}) {
  const head = card.messages[0];
  const isUser = head.role === "user";
  // 合并卡里任一条损坏都要示警,不能只看首条。
  const corrupted = card.messages.some((m) => m.metadata?.corrupted);
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
          {head.role}
        </span>
        {head.metadata?.claudeAppendix && (
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-900">
            {head.metadata.claudeEventType ?? "event"}
          </span>
        )}
        <span className="text-xs tabular-nums text-neutral-400">
          {formatFileTimeMs(new Date(head.timestamp).getTime())}
        </span>
        {head.model && (
          <span className="truncate font-mono text-[11px] text-neutral-500">
            {head.model}
          </span>
        )}
        {corrupted && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900">
            数据可能损坏
          </span>
        )}
      </header>

      {card.messages.map((m, i) => (
        <MessageBody
          key={m.id ?? `${card.key}-${i}`}
          m={m}
          expandAppendix={expandAppendix}
          readingMode={readingMode}
          answersByToolUseId={answersByToolUseId}
        />
      ))}
    </article>
  );
}

/**
 * 哨兵页脚文案。五种状态里**只有「到底了」那条跟方向有关** —— 倒序下「底」是对话开头,
 * 不是末尾。其余四条(加载中 / 本段全是工具调用 / 继续往下滚 / 全无可读内容)方向无关。
 * 抽成函数是因为原来那串嵌套三元已经三层,再叠一层 order 就没法读了。
 */
function footerText(args: {
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  empty: boolean;
  order: SortOrder;
}): string {
  if (args.isFetchingNextPage) return "加载更多消息…";
  if (args.hasNextPage) {
    // 本页全是工具调用/系统事件,滤完一条不剩。说清楚正在往下找,
    // 否则用户看到的是一块什么都没有、也不动的区域。
    return args.empty ? "这一段都是工具调用,继续往下找…" : "向下滚动加载更多";
  }
  if (args.empty) return "本会话没有可读的对话内容(全部是工具调用与系统事件)";
  return args.order === "desc" ? "已到对话开头" : "已到对话末尾";
}

/**
 * 消息虚拟列表:@tanstack/react-virtual + measureElement 自动测量。
 * - 滚动容器是 parentRef 这个 div(flex-1 填满剩余高度、内部纵向滚动、禁横向滚动)。
 * - 每行挂 virtualizer.measureElement,内建 ResizeObserver 自动量到真实高度并回填位置,
 *   无需手动 resetAfterIndex/行高缓存;内容变高(展开 thinking/details、正文加载)会自动重排。
 * - 末尾多一行哨兵页脚(index === cards.length):承载「加载中 / 已到末尾」,也是触底触发点。
 *
 * 两条不显然但要命的约束:
 * 1. **本组件的挂载条件必须用未过滤的消息数**(调用方 :items.length > 0)。哨兵在这里面,
 *    若按过滤后的数量判断,整页被滤空时组件不挂载 → 没有哨兵 → 永远拉不到下一页,
 *    而 isEmpty 又因 hasNextPage 为真而不成立 → 纯白页。空数组是自锁的。
 * 2. **必须传 getItemKey。** react-virtual 默认 keyExtractor 是 (index)=>index,
 *    而 itemSizeCache 按这个 key 存实测高度且 count 变化不清空 —— 切换开关后数组从
 *    579 变 112,新的 index 5 会直接复用旧 index 5 的高度,行高全错、锚定必飘。
 */
function MessageList({
  cards,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  expandAppendix,
  registerVirtualizer,
  readingMode,
  answersByToolUseId,
  order,
}: {
  cards: MergedCard<ApiMessage>[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  expandAppendix: boolean;
  registerVirtualizer?: (v: Virtualizer<HTMLDivElement, Element> | null) => void;
  readingMode: boolean;
  answersByToolUseId: Record<string, Record<string, string>>;
  order: SortOrder;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  // 末尾多一行哨兵页脚。
  const itemCount = cards.length + 1;

  // measureElement 内建 ResizeObserver 自动测量;react-virtual 默认对「视口上方项变高」自动
  // 补偿滚动(shouldAdjustScrollPositionOnItemSizeChange 的默认行为)——翻转全局展开开关、上方
  // appendix 就地展开时,滚动随之调整,当前视口内容不被挤走。
  const virtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 6,
    measureElement: (el) => el.getBoundingClientRect().height,
    // 见上方约束 2:按卡片身份而非下标缓存行高。
    getItemKey: (index) => (index >= cards.length ? "__footer__" : cards[index]!.key),
  });

  // 切换开关时页面层要拿它做锚定滚动。
  useEffect(() => {
    registerVirtualizer?.(virtualizer);
    return () => registerVirtualizer?.(null);
  }, [registerVirtualizer, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();

  // 触底:最后一个已渲染的虚拟行(哨兵页脚 / 最末消息)进入可视区 → 拉下一页。
  // cards 为空时 itemCount 仍是 1(哨兵),所以这条路径在「整页被滤空」时照样成立 ——
  // 哨兵立刻可见 → 继续拉,直到出现可见内容或到达末尾。这就是上方约束 1 要保住的自愈。
  useEffect(() => {
    const last = virtualItems.at(-1);
    if (!last) return;
    if (last.index >= cards.length - 1 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [virtualItems, cards.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

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
          const isFooter = virtualItem.index >= cards.length;
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
                    {footerText({
                      isFetchingNextPage,
                      hasNextPage,
                      empty: cards.length === 0,
                      order,
                    })}
                  </div>
                ) : (
                  <MessageArticle
                    card={cards[virtualItem.index]!}
                    expandAppendix={expandAppendix}
                    readingMode={readingMode}
                    answersByToolUseId={answersByToolUseId}
                  />
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

  // 全局「结构化内容默认展开」开关:开→当前可见 + 之后滚进来的 appendix 都自动展开(单块仍可手动开合)。
  const [expandAppendix, setExpandAppendix] = useState(false);
  // 「只看对话」开关。默认关,状态存 localStorage。
  const [readingMode, toggleReadingMode] = useReadingMode();
  // 「最新在前」开关。默认 asc(与页面一直以来的行为一致),独立存一个键。
  const [sortOrder, toggleSortOrder] = useSortOrder();

  // 头部:?meta=1 触发后端一次性索引(大文件约 1~2s),据此显示「首次打开」加载态。
  const meta = useQuery({
    queryKey: ["claude-code-history-session-meta", id, projectsRoot, projectId],
    queryFn: () => apiGet<MetaResp>(`${baseUrl}?meta=1${rootQs ? `&${rootQs.slice(1)}` : ""}`),
    enabled,
  });

  // 消息:?cursor=&limit= 向后翻页(oldest→new)。maxPages 上限累计页(顶部会被淘汰,
  // 阅读是自上而下,可接受;淘汰致索引位移时各行会重测自愈)。
  const messages = useInfiniteQuery({
    // order 必须进 key:方向变了数据也变。readingMode 刻意**不**进 key(它只改 limit,
    // 已拉的数据仍然有效),两者在这里是不对称的。
    queryKey: ["claude-code-history-session-page", id, projectsRoot, projectId, sortOrder],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      if (projectsRoot.trim()) p.set("projectsRoot", projectsRoot.trim());
      // desc 首屏的 pageParam 是 null —— 不带 cursor,让后端用当时的文件末尾作右边界。
      // 传 0 会被解释成右边界=0,读出空页。
      if (pageParam != null) p.set("cursor", String(pageParam));
      // 阅读模式下一页要拉更多才填得满一屏(见 READING_PAGE_LIMIT 注释)。
      p.set("limit", String(readingMode ? READING_PAGE_LIMIT : PAGE_LIMIT));
      if (sortOrder === "desc") p.set("order", "desc");
      return apiGet<PageResp>(`${baseUrl}?${p.toString()}`);
    },
    // asc 必须显式给 0:不带 cursor 会掉进后端那条整文件读的兼容路径。
    initialPageParam: (sortOrder === "desc" ? null : 0) as number | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    maxPages: MAX_PAGES,
    enabled,
  });

  const listParams = new URLSearchParams();
  if (projectsRoot.trim()) listParams.set("projectsRoot", projectsRoot.trim());
  if (projectId.trim()) listParams.set("project", projectId.trim());
  const listHref = `/claude-code-history${listParams.toString() ? `?${listParams}` : ""}`;

  // 锚定滚动:切换开关时把「当时视口顶部那条消息」重新滚回视口顶部。
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const registerVirtualizer = useCallback(
    (v: Virtualizer<HTMLDivElement, Element> | null) => {
      virtualizerRef.current = v;
    },
    []
  );
  /**
   * 切换开关的瞬间存下锚点与切换前的可见序列。
   * `until` 是重锚的截止时刻 —— 见下面 effect 里的说明。
   */
  const pendingAnchor = useRef<{
    id: string | null;
    prev: ApiMessage[];
    until: number;
  } | null>(null);

  const items = messages.data?.pages.flatMap((p) => p.messages) ?? [];
  const messagesReady = messages.isSuccess;
  // AskUserQuestion 的答案挂在**另一条** user 消息上(纯 tool_result),而那条在阅读模式下
  // 会被过滤掉 —— 所以必须在过滤**之前**按 tool_use_id 收集好。
  const answersByToolUseId: Record<string, Record<string, string>> = {};
  for (const m of items) {
    const key = m.metadata?.answersForToolUseId;
    const a = m.metadata?.answers;
    if (key && a) answersByToolUseId[key] = a;
  }
  // 阅读模式的两步变换。关闭时 visible === items 且每条各成一卡,渲染与改动前等价。
  const visible = readingMode ? filterByReadingHidden(items) : items;
  // 非阅读模式下每条各成一卡:desc 的顺序后端已经翻好了,这里不用再动。
  const cards: MergedCard<ApiMessage>[] = readingMode
    ? mergeAdjacentAssistant(visible, sortOrder)
    : visible.map((m, i) => ({
        key: m.id ?? `${m.role}-${i}`,
        role: m.role,
        messages: [m],
      }));

  /**
   * 切换排序 = 从新顺序的开头重新读(D3),所以这里**不做锚定**,但要主动收拾两样东西:
   *
   * 1. `pendingAnchor` 可能还留着上一次「只看对话」的锚点(2 秒窗口内)。不清掉的话
   *    那个 effect 会在切换后的重渲染里把落点顶走。
   * 2. 目标 order 的分页缓存要清。react-query 恢复无限查询时第一页用的是
   *    `oldPageParams[0] ?? initialPageParam` —— **缓存优先**,而 maxPages 淘汰会把
   *    首页连同它的 pageParam 一起删。长会话往返切换会落在半路而不是开头,
   *    且只在超过 40 页时才现形。
   */
  function onToggleSortOrder() {
    pendingAnchor.current = null;
    const nextOrder: SortOrder = sortOrder === "desc" ? "asc" : "desc";
    void queryClient.removeQueries({
      queryKey: [
        "claude-code-history-session-page",
        id,
        projectsRoot,
        projectId,
        nextOrder,
      ],
    });
    toggleSortOrder();
  }

  function onToggleReadingMode() {
    const v = virtualizerRef.current;
    const topIndex = v ? topVisibleIndex(v) : 0;
    pendingAnchor.current = {
      id: cards[topIndex]?.messages[0]?.id ?? null,
      prev: visible,
      until: Date.now() + ANCHOR_HOLD_MS,
    };
    toggleReadingMode();
  }

  /**
   * 切换后把锚点滚回视口顶部。
   *
   * 两个坑都得防住:
   * 1. **一帧不够。** ROW_ESTIMATE(180)与合并后卡片的真实高度差很远,而 measureElement
   *    只量已渲染的行 —— 锚点之上从未渲染过的行永远用估值,误差按 index 累积。所以先粗
   *    定位把目标行挂进 DOM,下一帧量到真实高度后再对一次。
   * 2. **一次也不够。** 打开开关会同时改变可见条数和每页 limit,触底逻辑随即补拉新页;
   *    新页到达时的重排会把刚对好的位置冲掉 —— 实测锚定只维持了一帧,随后滚回顶部。
   *    不能用 isFetchingNextPage 判断「灌完了」:切换后的那一帧补拉还没开始(仍是 false),
   *    照此清掉 pending,等新页真到达时已经没有锚点可用了。改成在一个短时间窗内,
   *    **每次 cards 变化都重新对准**,窗口过后放手。窗内用户手动滚动会被拉回一次,
   *    这是为「切换后位置不丢」付的代价,权衡后接受。
   */
  useEffect(() => {
    const pending = pendingAnchor.current;
    if (!pending) return;
    if (Date.now() > pending.until) {
      pendingAnchor.current = null;
      return;
    }
    const v = virtualizerRef.current;
    if (!v || cards.length === 0) return;
    const idx = computeAnchorIndex(cards, pending.id, pending.prev);
    v.scrollToIndex(idx, { align: "start" });
    const raf = requestAnimationFrame(() => {
      virtualizerRef.current?.scrollToIndex(idx, { align: "start" });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readingMode, cards.length, messages.isFetchingNextPage]);

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
  // 判空仍用**未过滤**的数量:真正「一条消息都没有」才是空会话。过滤后为空是另一回事,
  // 由 MessageList 的哨兵继续往下拉(见该组件顶部约束 1)。
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
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
          <SortOrderToggle order={sortOrder} onToggle={onToggleSortOrder} />
          <ReadingModeToggle on={readingMode} onToggle={onToggleReadingMode} />
          <Toggle
            label="结构化内容默认展开"
            on={expandAppendix}
            onToggle={() => setExpandAppendix((v) => !v)}
          />
        </div>
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
        {/* 挂载判断刻意用未过滤的 items:见 MessageList 顶部约束 1(空数组自锁 → 纯白页)。 */}
        {messagesReady && items.length > 0 && (
          <MessageList
            cards={cards}
            hasNextPage={Boolean(messages.hasNextPage)}
            isFetchingNextPage={messages.isFetchingNextPage}
            fetchNextPage={() => void messages.fetchNextPage()}
            expandAppendix={expandAppendix}
            registerVirtualizer={registerVirtualizer}
            readingMode={readingMode}
            answersByToolUseId={answersByToolUseId}
            order={sortOrder}
          />
        )}
      </div>
    </div>
  );
}
