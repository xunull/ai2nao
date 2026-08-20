import { useQuery } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Link } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiGet } from "../api";
import { formatTokenCount } from "../util/formatDisplay";

type WindowKey = "1d" | "3d" | "1w" | "2w" | "1m" | "3m" | "6m";

const WINDOWS: { value: WindowKey; label: string }[] = [
  { value: "1d", label: "1 天" },
  { value: "3d", label: "3 天" },
  { value: "1w", label: "1 周" },
  { value: "2w", label: "2 周" },
  { value: "1m", label: "1 月" },
  { value: "3m", label: "3 月" },
  { value: "6m", label: "6 月" },
];

const DEFAULT_WINDOW: WindowKey = "1w";

type Coverage = "full" | "partial" | "unknown";

/**
 * 认的源。**加一个源 = 这里加一项 + SOURCE_META 加一项。** 顺序即柱子堆叠顺序。
 * 与后端 `src/workTokensTrend/types.ts` 的 TOKEN_SOURCES 保持一致。
 *
 * ⚠️ web/ 与 src/ 是两套 tsconfig,前端不 import 后端类型 —— 也就是说
 * **两个 typecheck 都抓不到这里与后端 DTO 的漂移**。改后端形状时必须手动同步这里。
 */
const TOKEN_SOURCES = ["claude", "codex", "minimax"] as const;
type TokenSourceKey = (typeof TOKEN_SOURCES)[number];

/** 展示名与柱色。柱色是既有的,**不许改** —— 用户认这个颜色。 */
const SOURCE_META: Record<TokenSourceKey, { label: string; color: string }> = {
  claude: { label: "Claude", color: "#d97757" },
  codex: { label: "Codex", color: "#2563eb" },
  minimax: { label: "MiniMax", color: "#7c3aed" },
};

/** ok = 查到了(哪怕 0 行);failed = 查询抛了(表坏);absent = 这台机器没这个源。 */
type SourceState = "ok" | "failed" | "absent";

/** 这个源有没有这个维度 —— 用来决定「画一段 0」还是「根本不画」。 */
type SourceCapabilities = {
  cacheRead: boolean;
  cacheCreation: boolean;
  reasoningOutput: boolean;
  sessionCounts: boolean;
};

type SourceCostState = "full" | "partial" | "none";

/** 只存原子分量,派生量用下面的函数,不在组件里手写加减。 */
type SourceUsage = {
  state: SourceState;
  freshInput: number;
  cacheReadInput: number;
  cacheCreationInput: number;
  output: number;
  reasoningOutput: number;
  costUsd: number;
  pricedTokens: number;
  unpricedTokens: number;
  sessionCount: number;
  coveredSessionCount: number;
  unknownSessionCount: number;
  errorSessionCount: number;
};

const inputTokens = (u: SourceUsage): number =>
  u.freshInput + u.cacheReadInput + u.cacheCreationInput;
const totalTokens = (u: SourceUsage): number => inputTokens(u) + u.output;

/**
 * 「不含缓存」的量 = 真实新增 + 输出。**四个源统一**,两种 cache 都不算真实新增。
 *
 * 归一之前这里逐源不同:claude / codex 只减 cache-read,minimax 减 read + create ——
 * 同一个开关对三根柱子含义不同,读图的人无从得知。而且 types.ts 里 claude totals
 * 的注释写的又是「两个都减」,图表与文档自相矛盾。
 *
 * 注意它是**加法**不是减法。减法形式("total - 这些")正是逐源漂移的来源。
 */
const tokensExcludingCache = (u: SourceUsage): number => u.freshInput + u.output;

type Bucket = {
  bucketStart: string;
  bucketEnd: string;
  sources: Record<TokenSourceKey, SourceUsage>;
};

type Totals = {
  totalTokens: number;
  sources: Record<TokenSourceKey, SourceUsage & { share: number }>;
  costState: Record<TokenSourceKey, SourceCostState>;
  totalCostUsd: number;
  unpricedTokenCount: number;
  priceSnapshotDate: string;
  coverage: Coverage;
  coveredSessionCount: number;
  unknownSessionCount: number;
  errorSessionCount: number;
  totalSessionCount: number;
};

type MonthRange = { earliest: string; latest: string };

type Diagnostic = {
  severity: "info" | "warning" | "error";
  kind: string;
  message: string;
};

type PreviousWindow = {
  totalTokens: number;
  bySource: Record<
    TokenSourceKey,
    { totalTokens: number; freshInput: number; cacheReadInput: number; cacheCreationInput: number }
  >;
};

type TrendResponse =
  | {
      ok: true;
      generatedAt: string;
      mode: "window";
      windowKey: WindowKey;
      range: { from: string; to: string };
      bucketGranularity: "hour" | "3hour" | "day" | "week";
      buckets: Bucket[];
      totals: Totals;
      capabilities: Record<TokenSourceKey, SourceCapabilities>;
      previousWindow: PreviousWindow;
      deltaRatio: number | null;
      monthRange: MonthRange;
      diagnostics: Diagnostic[];
    }
  | {
      ok: true;
      generatedAt: string;
      mode: "month";
      monthKey: string;
      range: { from: string; to: string };
      bucketGranularity: "day";
      buckets: Bucket[];
      totals: Totals;
      capabilities: Record<TokenSourceKey, SourceCapabilities>;
      monthRange: MonthRange;
      diagnostics: Diagnostic[];
    };
function parseWindow(raw: string | null): WindowKey {
  if (raw && WINDOWS.some((w) => w.value === raw)) {
    return raw as WindowKey;
  }
  return DEFAULT_WINDOW;
}

function isMonthKey(raw: string | null): raw is string {
  return !!raw && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw);
}

function bucketLabel(b: Bucket, granularity: TrendResponse["bucketGranularity"]): string {
  const start = new Date(b.bucketStart);
  switch (granularity) {
    case "hour":
    case "3hour":
      return start.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    case "day":
      return start.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
    case "week":
      return start.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  }
}

/**
 * recharts 的 `dataKey` 只能是平的字符串键,所以每个源在行上占一个数值键
 * (键名就是 source key)。原始桶挂在 `bucket` 上给 tooltip 用。
 *
 * 归一之前这里是 `claudeFullTokens` / `codexFullTokens` / `minimaxFullTokens`
 * 三个写死的字段 + 一个硬编码 `minimaxCostUsd: 0`。
 */
type ChartRow = Record<TokenSourceKey, number> & {
  label: string;
  bucket: Bucket;
};

function StatCard({
  label,
  value,
  subtle,
}: {
  label: string;
  value: string;
  subtle?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--fg-muted)]">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-[var(--fg)]">{value}</div>
      {subtle && <div className="mt-1 text-xs text-[var(--fg-muted)]">{subtle}</div>}
    </div>
  );
}

/**
 * 2×3 input/output breakdown matrix.
 *
 * Rows: Claude / Codex / 合计. Cols: 输入 / 输出 / 小计.
 * All numbers are token_status='full' only, scoped to the current window/month
 * (same predicate as the chart). Empty cells render `0`, not `—`.
 *
 * Note: Claude 输入 is the FUSED value (includes cache_creation + cache_read),
 * so it reads much larger than 输出 — that's billing-accurate, not a bug. A
 * future change will split out cache hits separately.
 */
function BreakdownMatrix({
  totals,
  includeCache,
}: {
  totals: Totals;
  includeCache: boolean;
}) {
  // 逐源遍历 —— 归一之前这里写死了 Claude / Codex 两行(MiniMax 从来没进过这张表,
  // 加源也不会自动出现)。现在 TOKEN_SOURCES 有谁就有谁。
  const perSource = TOKEN_SOURCES.map((key) => ({
    label: SOURCE_META[key].label,
    dot: SOURCE_META[key].color,
    input: inputTokens(totals.sources[key]),
    output: totals.sources[key].output,
    total: totalTokens(totals.sources[key]),
  })).filter((r) => r.total > 0);
  const inputTotal = perSource.reduce((n, r) => n + r.input, 0);
  const outputTotal = perSource.reduce((n, r) => n + r.output, 0);
  const grandTotal = inputTotal + outputTotal;

  const rows: {
    label: string;
    dot?: string;
    input: number;
    output: number;
    total: number;
    bold?: boolean;
  }[] = [
    ...perSource,
    {
      label: "合计",
      input: inputTotal,
      output: outputTotal,
      total: grandTotal,
      bold: true,
    },
  ];

  return (
    <section className="mb-5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--fg)]">输入 / 输出拆分</h2>
        <span className="text-xs text-[var(--fg-muted)]">
          仅统计完整 token 的 session · {includeCache ? "含 cache" : "不含命中 cache"}
        </span>
      </div>
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-[var(--fg-muted)]">
            <th className="py-1.5 text-left font-medium">来源</th>
            <th className="py-1.5 text-right font-medium">输入</th>
            <th className="py-1.5 text-right font-medium">输出</th>
            <th className="py-1.5 text-right font-medium">小计</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.label}
              className={`border-t border-[var(--border)] ${
                r.bold ? "font-semibold text-[var(--fg)]" : "text-[var(--fg)]"
              }`}
            >
              <td className="py-1.5 text-left">
                <span className="flex items-center gap-1.5">
                  {r.dot && (
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ background: r.dot }}
                    />
                  )}
                  {r.label}
                </span>
              </td>
              <td className="py-1.5 text-right">{formatTokenCount(r.input)}</td>
              <td className="py-1.5 text-right">{formatTokenCount(r.output)}</td>
              <td className="py-1.5 text-right">{formatTokenCount(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * 一个源的「输入构成」或「输出构成」。
 *
 * 归一之前这里是**四个组件**:Claude/Codex × 输入/输出,同一套堆叠比例条 + 表格
 * 复制了四遍。加一个源要再复制两遍,而每个源具备哪些段是硬编码在组件名里的。
 * 现在段由 `capabilities` 决定,组件只剩两个,加源零改动。
 */
function CompositionSection({
  title,
  hint,
  total,
  totalLabel,
  segments,
}: {
  title: string;
  hint?: string;
  total: number;
  totalLabel: string;
  segments: { label: string; value: number; color: string; hint: string }[];
}) {
  if (total <= 0) return null;
  const pct = (v: number) => (total === 0 ? 0 : (v / total) * 100);
  return (
    <section className="mb-5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--fg)]">{title}</h2>
        {hint ? <span className="text-xs text-[var(--fg-muted)]">{hint}</span> : null}
      </div>
      <div className="mb-3 flex h-3 w-full overflow-hidden rounded-sm">
        {segments.map((s) => (
          <div
            key={s.label}
            style={{ width: `${pct(s.value)}%`, background: s.color }}
            title={`${s.label} ${formatTokenCount(s.value)}`}
          />
        ))}
      </div>
      <table className="w-full text-sm tabular-nums">
        <tbody>
          {segments.map((s) => (
            <tr key={s.label} className="text-[var(--fg)]">
              <td className="py-1 text-left">
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ background: s.color }}
                  />
                  {s.label}
                  <span className="text-xs text-[var(--fg-muted)]">{s.hint}</span>
                </span>
              </td>
              <td className="py-1 text-right">{formatTokenCount(s.value)}</td>
              <td className="py-1 pl-3 text-right text-xs text-[var(--fg-muted)]">
                {`${pct(s.value).toFixed(1)}%`}
              </td>
            </tr>
          ))}
          <tr className="border-t border-[var(--border)] font-semibold text-[var(--fg)]">
            <td className="py-1 text-left">{totalLabel}</td>
            <td className="py-1 text-right">{formatTokenCount(total)}</td>
            <td className="py-1 pl-3 text-right text-xs text-[var(--fg-muted)]">100%</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

/** cache 段的固定配色(与源无关,读者认的是「灰=回放、橙=写入」)。 */
const CACHE_CREATION_COLOR = "#f0a868";
const CACHE_READ_COLOR = "#9ca3af";
const REASONING_COLOR = "#8b5cf6";

/**
 * 输入构成:真实新增 / 写入 cache / 命中 cache。
 * **段由 capabilities 决定** —— codex 没有 cache 写入这个概念,就不画那一段,
 * 而不是画一段永远为 0 的东西让人以为「codex 这段时间没写 cache」。
 */
function InputComposition({
  sourceKey,
  usage,
  caps,
}: {
  sourceKey: TokenSourceKey;
  usage: SourceUsage;
  caps: SourceCapabilities;
}) {
  const input = inputTokens(usage);
  const segments: { label: string; value: number; color: string; hint: string }[] = [
    {
      label: "真实新增",
      value: usage.freshInput,
      color: SOURCE_META[sourceKey].color,
      hint: "本轮首次喂入的新内容",
    },
  ];
  if (caps.cacheCreation) {
    segments.push({
      label: "写入 cache",
      value: usage.cacheCreationInput,
      color: CACHE_CREATION_COLOR,
      hint: "首次写入 prompt cache",
    });
  }
  if (caps.cacheRead) {
    segments.push({
      label: "命中 cache",
      value: usage.cacheReadInput,
      color: CACHE_READ_COLOR,
      hint: "从 cache 回放（命中）",
    });
  }
  const hitRate = input === 0 ? 0 : (usage.cacheReadInput / input) * 100;
  return (
    <CompositionSection
      title={`${SOURCE_META[sourceKey].label} 输入构成`}
      hint={caps.cacheRead ? `cache 命中率 ${hitRate.toFixed(1)}%` : undefined}
      total={input}
      totalLabel="输入合计"
      segments={segments}
    />
  );
}

/**
 * 输出构成:推理 / 正常输出。
 *
 * ⚠️ **没有 reasoning 概念的源也要画**,只是不拆分 —— 否则读者会以为
 * 「这个源没有输出」。这条是既有设计意图,写在测试名里:
 * "renders Claude 输出构成 (single-value, no sub-split) so claude output
 *  isn't perceived as absent"。归一时差点把它丢了。
 */
function OutputComposition({
  sourceKey,
  usage,
  caps,
}: {
  sourceKey: TokenSourceKey;
  usage: SourceUsage;
  caps: SourceCapabilities;
}) {
  const reasoning = usage.reasoningOutput;
  const normal = Math.max(0, usage.output - reasoning);
  const rate = usage.output === 0 ? 0 : (reasoning / usage.output) * 100;
  const segments = caps.reasoningOutput
    ? [
        { label: "推理", value: reasoning, color: REASONING_COLOR, hint: "thinking token" },
        {
          label: "正常输出",
          value: normal,
          color: SOURCE_META[sourceKey].color,
          hint: "写给你看的正文",
        },
      ]
    : [
        {
          label: "无细分",
          value: usage.output,
          color: SOURCE_META[sourceKey].color,
          hint: "无推理 / 缓存细分",
        },
      ];
  return (
    <CompositionSection
      title={`${SOURCE_META[sourceKey].label} 输出构成`}
      hint={caps.reasoningOutput ? `推理占比 ${rate.toFixed(1)}%` : undefined}
      total={usage.output}
      totalLabel="输出合计"
      segments={segments}
    />
  );
}

// Recharts 2.x's TooltipProps surface drifts across minor versions, so we
// type the prop bag locally instead of importing it.
type CustomTooltipProps = {
  active?: boolean;
  payload?: Array<{ payload: ChartRow }>;
  label?: string | number;
  costMode?: boolean;
};

function CustomTooltip({ active, payload, label, costMode }: CustomTooltipProps): React.ReactElement | null {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  const fmt = costMode ? formatUsd : formatTokenCount;
  // 逐源遍历。state 不是 ok 的源单独标注 —— 0 与「查询失败」不能长得一样。
  const shown = TOKEN_SOURCES.map((key) => ({
    key,
    label: SOURCE_META[key].label,
    value: row[key],
    state: row.bucket.sources[key].state,
  })).filter((r) => r.state !== "absent");
  const sum = shown.reduce((n, r) => n + r.value, 0);
  const sessions = TOKEN_SOURCES.reduce(
    (acc, key) => {
      const u = row.bucket.sources[key];
      acc.covered += u.coveredSessionCount;
      acc.total += u.sessionCount;
      acc.imperfect += u.unknownSessionCount + u.errorSessionCount;
      return acc;
    },
    { covered: 0, total: 0, imperfect: 0 }
  );
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 text-xs shadow-sm">
      <div className="mb-1 font-semibold text-[var(--fg)]">{label}</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
        {shown.map((r) => (
          <Fragment key={r.key}>
            <span className="text-[var(--fg-muted)]">{r.label}:</span>
            <span className="text-right text-[var(--fg)]">
              {r.state === "failed" ? "查询失败" : fmt(r.value)}
            </span>
          </Fragment>
        ))}
        <span className="text-[var(--fg-muted)]">合计:</span>
        <span className="text-right font-semibold text-[var(--fg)]">{fmt(sum)}</span>
      </div>
      {sessions.imperfect > 0 && (
        <div className="mt-2 border-t border-[var(--border)] pt-1 text-[10px] text-amber-700">
          {sessions.covered} / {sessions.total} session 有真实 token
        </div>
      )}
    </div>
  );
}

function buildMonthOptions(range: MonthRange | undefined): string[] {
  if (!range) return [];
  const out: string[] = [];
  const [eY, eM] = range.earliest.split("-").map(Number);
  const [lY, lM] = range.latest.split("-").map(Number);
  let y = lY;
  let m = lM;
  while (y > eY || (y === eY && m >= eM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

const CACHE_TOGGLE_KEY = "tokensTrend.includeCache";
const COST_TOGGLE_KEY = "tokensTrend.showCost";

/** Format a USD amount: $1.23, $12.3K, $1.23M. Always shows the $ sign. */
function formatUsd(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
}

/** Boolean toggle persisted to localStorage (survives refresh). */
function useStickyToggle(
  key: string,
  initial: boolean
): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : raw === "1";
    } catch {
      return initial;
    }
  });
  const set = (next: boolean): void => {
    setValue(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      /* localStorage unavailable (private mode) — keep in-memory only */
    }
  };
  return [value, set];
}

/**
 * Re-derive the totals card under the cache toggle. When `includeCache` is
 * false we strip the per-turn cache replay that dominates long sessions:
 * Claude's `cache_read_input_tokens` AND Codex's `cached_input_tokens` (its
 * mirror). Both are subtracted from the respective input/totals, then the grand
 * total + shares recompute. Raw cache fields are preserved so the
 * "Claude/Codex 输入构成" explainer cards still show the full split regardless.
 */
function deriveTotals(totals: Totals, includeCache: boolean): Totals {
  if (includeCache) return totals;
  // 统一口径:两种 cache 都不算「真实新增」,直接归零,剩下 fresh + output。
  const sources = {} as Totals["sources"];
  let grand = 0;
  for (const key of TOKEN_SOURCES) {
    const u = totals.sources[key];
    const next = { ...u, cacheReadInput: 0, cacheCreationInput: 0 };
    sources[key] = { ...next, share: 0 };
    grand += totalTokens(next);
  }
  for (const key of TOKEN_SOURCES) {
    sources[key].share = grand === 0 ? 0 : totalTokens(sources[key]) / grand;
  }
  return { ...totals, sources, totalTokens: grand };
}

/** Header toggle: include Claude cache hits in the aggregate numbers. */
function CacheToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      title="关掉后，总量/占比/拆分/柱状图都不计入命中 cache（Claude + Codex 每轮重放的缓存）"
      className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg-muted)] hover:bg-[var(--surface-2)]"
    >
      <span className="text-[var(--fg)]">计入缓存命中</span>
      <span
        className={`relative inline-block h-4 w-7 rounded-full transition-colors ${
          on ? "bg-[#d97757]" : "bg-[var(--border)]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
            on ? "left-3.5" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

/** Header toggle: show estimated USD cost (equivalent API cost, not a bill). */
function CostToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      title="显示等价 API 成本（按模型单价估算，非实际订阅扣费）"
      className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg-muted)] hover:bg-[var(--surface-2)]"
    >
      <span className="text-[var(--fg)]">显示 USD 成本</span>
      <span
        className={`relative inline-block h-4 w-7 rounded-full transition-colors ${
          on ? "bg-emerald-600" : "bg-[var(--border)]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
            on ? "left-3.5" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

export function WorkTokensTrend() {
  const [searchParams, setSearchParams] = useSearchParams();
  const monthRaw = searchParams.get("month");
  const isMonthMode = isMonthKey(monthRaw);
  const currentWindow = parseWindow(searchParams.get("window"));

  const queryUrl = isMonthMode
    ? `/api/work-tokens-trend?month=${monthRaw}`
    : `/api/work-tokens-trend?window=${currentWindow}`;

  const [includeCache, setIncludeCache] = useStickyToggle(CACHE_TOGGLE_KEY, true);
  const [showCost, setShowCost] = useStickyToggle(COST_TOGGLE_KEY, false);

  const trend = useQuery<TrendResponse>({
    queryKey: ["work-tokens-trend", isMonthMode ? `month:${monthRaw}` : `window:${currentWindow}`],
    queryFn: () => apiGet<TrendResponse>(queryUrl),
  });

  const chartData = useMemo<ChartRow[]>(() => {
    if (!trend.data) return [];
    return trend.data.buckets.map((b) => {
      const row = {
        label: bucketLabel(b, trend.data!.bucketGranularity),
        bucket: b,
      } as ChartRow;
      for (const key of TOKEN_SOURCES) {
        const u = b.sources[key];
        const total = totalTokens(u);
        row[key] = showCost
          ? u.costUsd
          : includeCache
            ? total
            : tokensExcludingCache(u);
      }
      return row;
    });
  }, [trend.data, includeCache, showCost]);

  // Totals + 环比 under the cache toggle. Raw totals still feed the
  // "Claude 输入构成" explainer; everything aggregate uses the effective view.
  const effectiveTotals = useMemo(
    () => (trend.data ? deriveTotals(trend.data.totals, includeCache) : null),
    [trend.data, includeCache]
  );
  const effectivePrevTotal =
    trend.data?.mode === "window"
      ? includeCache
        ? trend.data.previousWindow.totalTokens
        : // 与柱子同一把尺:四家都减掉两种 cache。
          // (归一之前这里只减 claude 与 codex 的 cache-read —— 后端一直提供
          //  minimax 的 cache 字段,前端从没接上。T6 一并修好。)
          TOKEN_SOURCES.reduce((n, key) => {
            const p =
              trend.data!.mode === "window"
                ? trend.data!.previousWindow.bySource[key]
                : null;
            if (!p) return n;
            return (
              n + Math.max(0, p.totalTokens - p.cacheReadInput - p.cacheCreationInput)
            );
          }, 0)
      : 0;
  const effectiveDeltaRatio =
    effectiveTotals && effectivePrevTotal > 0
      ? (effectiveTotals.totalTokens - effectivePrevTotal) / effectivePrevTotal
      : null;

  /** 这个源此刻的状态。没有数据时当 absent(不画)。 */
  const sourceState = (key: TokenSourceKey): SourceState =>
    trend.data?.totals.sources[key].state ?? "absent";
  /**
   * 要画哪些源。`absent`(这台机器没这个源)不画 —— 画一根永远为 0 的柱子
   * 会让人以为「用了但没花 token」。`failed` 要画并标注,那是坏了不是零。
   */
  const visibleSources = TOKEN_SOURCES.filter((key) => sourceState(key) !== "absent");

  const monthOptions = useMemo(
    () => buildMonthOptions(trend.data?.monthRange),
    [trend.data]
  );

  const updateParams = (mutator: (params: URLSearchParams) => void): void => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      mutator(next);
      return next;
    });
  };

  return (
    <main className="mx-auto max-w-[1760px] px-8 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--fg)]">Token 趋势</h1>
          <p className="mt-1 text-xs text-[var(--fg-muted)]">
            按时间维度回看本机 Claude Code / Codex 的真实 token 消耗。数字来自
            两张已索引 session 表的 SUM；不估算成本，不猜测缺失值。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CostToggle on={showCost} onChange={setShowCost} />
          <CacheToggle on={includeCache} onChange={setIncludeCache} />
          <label className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
            窗口
            <select
              value={isMonthMode ? "" : currentWindow}
              disabled={isMonthMode}
              onChange={(e) => {
                const next = e.target.value as WindowKey;
                updateParams((params) => {
                  params.set("window", next);
                  params.delete("month");
                });
              }}
              className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--fg)] disabled:opacity-50"
              aria-label="时间窗口"
            >
              {WINDOWS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
            月份
            <select
              value={isMonthMode ? (monthRaw ?? "") : ""}
              onChange={(e) => {
                const next = e.target.value;
                if (!next) return;
                updateParams((params) => {
                  params.set("month", next);
                  params.delete("window");
                });
              }}
              className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--fg)]"
              aria-label="月份"
            >
              <option value="">选择月份</option>
              {monthOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          {isMonthMode && (
            <button
              type="button"
              onClick={() =>
                updateParams((params) => {
                  params.delete("month");
                  params.set("window", currentWindow);
                })
              }
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg-muted)] hover:bg-[var(--surface-2)]"
            >
              清除月份
            </button>
          )}
        </div>
      </header>

      {trend.isError && (
        <div className="mb-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          读取失败：{(trend.error as Error).message}
        </div>
      )}

      {trend.data && effectiveTotals && (
        <>
          {!includeCache && (
            <div className="mb-4 rounded-md bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--fg-muted)] ring-1 ring-[var(--border)]">
              已排除命中 cache（Claude + Codex 每轮重放的缓存）。总量、占比、拆分、柱状图与环比均按此口径；
              下方「输入构成」卡始终展示完整拆分。
            </div>
          )}
          <section className="mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="窗口内总 token"
              value={formatTokenCount(effectiveTotals.totalTokens)}
              subtle={`${effectiveTotals.totalSessionCount} session`}
            />
            {TOKEN_SOURCES.filter(
              (key) => effectiveTotals.sources[key].state !== "absent"
            ).map((key) => (
              <StatCard
                key={`share-${key}`}
                label={`${SOURCE_META[key].label} 占比`}
                value={`${(effectiveTotals.sources[key].share * 100).toFixed(1)}%`}
                subtle={formatTokenCount(totalTokens(effectiveTotals.sources[key]))}
              />
            ))}
            {trend.data.mode === "window" ? (
              <StatCard
                label="环比上一窗口"
                value={
                  effectiveDeltaRatio === null
                    ? "—"
                    : `${effectiveDeltaRatio >= 0 ? "+" : ""}${(effectiveDeltaRatio * 100).toFixed(1)}%`
                }
                subtle={`前期 ${formatTokenCount(effectivePrevTotal)}`}
              />
            ) : (
              <StatCard label="环比" value="—" subtle="月模式不展示环比" />
            )}
          </section>

          {showCost && (
            <section className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50/40 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-[var(--fg)]">
                  等价 API 成本（估算）
                </h2>
                <span className="text-xs text-[var(--fg-muted)]">
                  非实际订阅扣费 · 价格快照 {trend.data.totals.priceSnapshotDate}
                </span>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <StatCard
                  label="总成本"
                  value={formatUsd(trend.data.totals.totalCostUsd)}
                  subtle="按模型单价 · 含 cache 分段计价"
                />
                {TOKEN_SOURCES.filter(
                  (key) => trend.data!.totals.costState[key] !== "none"
                ).map((key) => (
                  <StatCard
                    key={`cost-${key}`}
                    label={`${SOURCE_META[key].label} 成本`}
                    value={formatUsd(trend.data!.totals.sources[key].costUsd)}
                  />
                ))}
              </div>
              {trend.data.totals.unpricedTokenCount > 0 && (
                <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
                  有 {formatTokenCount(trend.data.totals.unpricedTokenCount)} token
                  的模型不在价格快照中，未计入成本（不猜测）。
                </div>
              )}
            </section>
          )}

          <BreakdownMatrix totals={effectiveTotals} includeCache={includeCache} />

          {TOKEN_SOURCES.map((key) => (
            <InputComposition
              key={`in-${key}`}
              sourceKey={key}
              usage={trend.data!.totals.sources[key]}
              caps={trend.data!.capabilities[key]}
            />
          ))}

          {TOKEN_SOURCES.map((key) => (
            <OutputComposition
              key={`out-${key}`}
              sourceKey={key}
              usage={trend.data!.totals.sources[key]}
              caps={trend.data!.capabilities[key]}
            />
          ))}

          <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--fg)]">
                {isMonthMode
                  ? `${trend.data.mode === "month" ? trend.data.monthKey : ""} 按天分布`
                  : `${WINDOWS.find((w) => w.value === currentWindow)?.label} 趋势`}
              </h2>
              <div className="flex items-center gap-3 text-xs text-[var(--fg-muted)]">
                {visibleSources.map((key) => (
                  <span key={`lg-${key}`} className="flex items-center gap-1">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ background: SOURCE_META[key].color }}
                    />
                    {SOURCE_META[key].label}
                    {key === "minimax" && (
                      <span className="text-[10px] text-[var(--fg-muted)]">(账单 T+1)</span>
                    )}
                    {sourceState(key) === "failed" && (
                      <span className="text-[10px] text-red-600">查询失败</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ width: "100%", height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e4e4e7" />
                  <XAxis dataKey="label" axisLine={false} tickLine={false} fontSize={11} />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    fontSize={11}
                    tickFormatter={(v: number) => (showCost ? formatUsd(v) : formatTokenCount(v))}
                    width={50}
                  />
                  <Tooltip content={<CustomTooltip costMode={showCost} />} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
                  {/* 逐源出柱。归一之前是三行写死的 <Bar>,加源要记得回来补一行。 */}
                  {visibleSources.map((key) => (
                    <Bar
                      key={`bar-${key}`}
                      dataKey={key}
                      stackId="tokens"
                      fill={SOURCE_META[key].color}
                      radius={0}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          {trend.data.totals.coverage !== "full" && (
            <div className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
              {trend.data.totals.coverage === "unknown"
                ? "这段时间没有完整 token usage 记录。先去 "
                : `${trend.data.totals.coveredSessionCount} / ${trend.data.totals.totalSessionCount} session 有真实 token。补全数据可去 `}
              <Link to="/scheduler" className="underline">
                定时任务
              </Link>
              {" 运行 token 刷新。"}
            </div>
          )}
        </>
      )}

      {trend.isLoading && !trend.data && (
        <div className="rounded-lg border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--fg-muted)]">
          读取中…
        </div>
      )}
    </main>
  );
}
