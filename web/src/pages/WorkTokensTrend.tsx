import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
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

type Bucket = {
  bucketStart: string;
  bucketEnd: string;
  claudeTokens: number;
  codexTokens: number;
  /** Claude cache_read in this bucket — subtracted when the cache toggle is off. */
  claudeCacheReadInputTokens: number;
  claudeSessionCount: number;
  codexSessionCount: number;
  claudeCoveredSessionCount: number;
  codexCoveredSessionCount: number;
  claudeUnknownSessionCount: number;
  codexUnknownSessionCount: number;
  claudeErrorSessionCount: number;
  codexErrorSessionCount: number;
};

type Totals = {
  totalTokens: number;
  claudeTokens: number;
  codexTokens: number;
  claudeInputTokens: number;
  claudeOutputTokens: number;
  codexInputTokens: number;
  codexOutputTokens: number;
  claudeCacheReadInputTokens: number;
  claudeCacheCreationInputTokens: number;
  codexReasoningOutputTokens: number;
  claudeShare: number;
  codexShare: number;
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
      previousWindowTotal: number;
      previousWindowClaudeCacheReadInputTokens: number;
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

type ChartRow = Bucket & {
  label: string;
  // F1 spike-compatible field split: separate full vs unknown/error so that
  // a future Recharts <pattern> fill can be applied per series. v1 we only
  // visualize the *Full series; partial sessions show up in coverage UI
  // rather than a separate hatched series.
  claudeFullTokens: number;
  codexFullTokens: number;
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
  const claudeTotal = totals.claudeInputTokens + totals.claudeOutputTokens;
  const codexTotal = totals.codexInputTokens + totals.codexOutputTokens;
  const inputTotal = totals.claudeInputTokens + totals.codexInputTokens;
  const outputTotal = totals.claudeOutputTokens + totals.codexOutputTokens;
  const grandTotal = inputTotal + outputTotal;

  const rows: {
    label: string;
    dot?: string;
    input: number;
    output: number;
    total: number;
    bold?: boolean;
  }[] = [
    {
      label: "Claude",
      dot: "#d97757",
      input: totals.claudeInputTokens,
      output: totals.claudeOutputTokens,
      total: claudeTotal,
    },
    {
      label: "Codex",
      dot: "#2563eb",
      input: totals.codexInputTokens,
      output: totals.codexOutputTokens,
      total: codexTotal,
    },
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
          仅统计完整 token 的 session · {includeCache ? "含 cache" : "不含 Claude 命中 cache"}
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
 * Claude 输入构成 —— breaks Claude's (cache-inflated) input into three parts:
 *   命中 cache (read)  — replayed from cache, cheap, the bulk on long sessions
 *   写入 cache (write) — first-time cache fill
 *   真实新增 (fresh)   — claudeInput - read - write, the actually-new bytes
 *
 * Cache is a Claude-only concept (Codex has no equivalent), so this lives in
 * its own section rather than the shared 2×3 matrix. 命中率 = read / input.
 * Hidden entirely when there are no Claude input tokens in the window.
 */
function ClaudeInputComposition({ totals }: { totals: Totals }) {
  const input = totals.claudeInputTokens;
  if (input <= 0) return null;
  const read = totals.claudeCacheReadInputTokens;
  const creation = totals.claudeCacheCreationInputTokens;
  const fresh = Math.max(0, input - read - creation);
  const hitRate = input === 0 ? 0 : (read / input) * 100;

  const segments: { label: string; value: number; color: string; hint: string }[] = [
    { label: "真实新增", value: fresh, color: "#d97757", hint: "本轮首次喂入的新内容" },
    { label: "写入 cache", value: creation, color: "#f0a868", hint: "首次写入 prompt cache" },
    { label: "命中 cache", value: read, color: "#9ca3af", hint: "从 cache 回放（命中）" },
  ];

  return (
    <section className="mb-5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--fg)]">Claude 输入构成</h2>
        <span className="text-xs text-[var(--fg-muted)]">
          cache 命中率 {hitRate.toFixed(1)}%
        </span>
      </div>
      {/* stacked proportion bar */}
      <div className="mb-3 flex h-3 w-full overflow-hidden rounded-sm">
        {segments.map((s) => (
          <div
            key={s.label}
            style={{
              width: `${input === 0 ? 0 : (s.value / input) * 100}%`,
              background: s.color,
            }}
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
                {input === 0 ? "0%" : `${((s.value / input) * 100).toFixed(1)}%`}
              </td>
            </tr>
          ))}
          <tr className="border-t border-[var(--border)] font-semibold text-[var(--fg)]">
            <td className="py-1 text-left">输入合计</td>
            <td className="py-1 text-right">{formatTokenCount(input)}</td>
            <td className="py-1 pl-3 text-right text-xs text-[var(--fg-muted)]">100%</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

/**
 * Codex 输出构成 —— mirror of ClaudeInputComposition, on the output side.
 * Codex's output_tokens already includes reasoning (thinking) tokens, so we
 * split the total output into 推理 (reasoning) + 正常输出 (visible output =
 * output - reasoning). reasoning is a Codex-only concept (Claude has none),
 * so this lives in its own section, not the shared 2×3 matrix. 推理占比 =
 * reasoning / output. Hidden when there is no Codex output in the window.
 */
function CodexOutputComposition({ totals }: { totals: Totals }) {
  const output = totals.codexOutputTokens;
  if (output <= 0) return null;
  const reasoning = totals.codexReasoningOutputTokens;
  const visible = Math.max(0, output - reasoning);
  const reasoningRate = output === 0 ? 0 : (reasoning / output) * 100;

  const segments: { label: string; value: number; color: string; hint: string }[] = [
    { label: "正常输出", value: visible, color: "#2563eb", hint: "模型实际产出的可见输出" },
    { label: "推理", value: reasoning, color: "#9ca3af", hint: "thinking / reasoning，已含在输出内" },
  ];

  return (
    <section className="mb-5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--fg)]">Codex 输出构成</h2>
        <span className="text-xs text-[var(--fg-muted)]">
          推理占比 {reasoningRate.toFixed(1)}%
        </span>
      </div>
      {/* stacked proportion bar */}
      <div className="mb-3 flex h-3 w-full overflow-hidden rounded-sm">
        {segments.map((s) => (
          <div
            key={s.label}
            style={{
              width: `${output === 0 ? 0 : (s.value / output) * 100}%`,
              background: s.color,
            }}
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
                {output === 0 ? "0%" : `${((s.value / output) * 100).toFixed(1)}%`}
              </td>
            </tr>
          ))}
          <tr className="border-t border-[var(--border)] font-semibold text-[var(--fg)]">
            <td className="py-1 text-left">输出合计</td>
            <td className="py-1 text-right">{formatTokenCount(output)}</td>
            <td className="py-1 pl-3 text-right text-xs text-[var(--fg-muted)]">100%</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

// Recharts 2.x's TooltipProps surface drifts across minor versions, so we
// type the prop bag locally instead of importing it.
type CustomTooltipProps = {
  active?: boolean;
  payload?: Array<{ payload: ChartRow }>;
  label?: string | number;
};

function CustomTooltip({ active, payload, label }: CustomTooltipProps): React.ReactElement | null {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 text-xs shadow-sm">
      <div className="mb-1 font-semibold text-[var(--fg)]">{label}</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
        <span className="text-[var(--fg-muted)]">Claude:</span>
        <span className="text-right text-[var(--fg)]">{formatTokenCount(row.claudeFullTokens)}</span>
        <span className="text-[var(--fg-muted)]">Codex:</span>
        <span className="text-right text-[var(--fg)]">{formatTokenCount(row.codexFullTokens)}</span>
        <span className="text-[var(--fg-muted)]">合计:</span>
        <span className="text-right font-semibold text-[var(--fg)]">
          {formatTokenCount(row.claudeFullTokens + row.codexFullTokens)}
        </span>
      </div>
      {(row.claudeUnknownSessionCount + row.codexUnknownSessionCount + row.claudeErrorSessionCount + row.codexErrorSessionCount) > 0 && (
        <div className="mt-2 border-t border-[var(--border)] pt-1 text-[10px] text-amber-700">
          {row.claudeCoveredSessionCount + row.codexCoveredSessionCount} / {row.claudeSessionCount + row.codexSessionCount} session 有真实 token
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
 * false we strip Claude's `cache_read_input_tokens` (the per-turn cache replay
 * that dominates long sessions) from Claude's totals and recompute the grand
 * total + shares. Codex is untouched — this toggle is about Claude cache only.
 * Raw cache fields are preserved so the "Claude 输入构成" explainer card still
 * shows the full split regardless of the toggle.
 */
function deriveTotals(totals: Totals, includeCache: boolean): Totals {
  if (includeCache) return totals;
  const cut = totals.claudeCacheReadInputTokens;
  const claudeTokens = Math.max(0, totals.claudeTokens - cut);
  const claudeInputTokens = Math.max(0, totals.claudeInputTokens - cut);
  const totalTokens = claudeTokens + totals.codexTokens;
  return {
    ...totals,
    claudeTokens,
    claudeInputTokens,
    totalTokens,
    claudeShare: totalTokens === 0 ? 0 : claudeTokens / totalTokens,
    codexShare: totalTokens === 0 ? 0 : totals.codexTokens / totalTokens,
  };
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
      title="关掉后，总量/占比/拆分/柱状图都不计入 Claude 的命中 cache（每轮重放）"
      className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--fg-muted)] hover:bg-[var(--surface-2)]"
    >
      <span className="text-[var(--fg)]">计入 Claude 缓存命中</span>
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

export function WorkTokensTrend() {
  const [searchParams, setSearchParams] = useSearchParams();
  const monthRaw = searchParams.get("month");
  const isMonthMode = isMonthKey(monthRaw);
  const currentWindow = parseWindow(searchParams.get("window"));

  const queryUrl = isMonthMode
    ? `/api/work-tokens-trend?month=${monthRaw}`
    : `/api/work-tokens-trend?window=${currentWindow}`;

  const [includeCache, setIncludeCache] = useStickyToggle(CACHE_TOGGLE_KEY, true);

  const trend = useQuery<TrendResponse>({
    queryKey: ["work-tokens-trend", isMonthMode ? `month:${monthRaw}` : `window:${currentWindow}`],
    queryFn: () => apiGet<TrendResponse>(queryUrl),
  });

  const chartData = useMemo<ChartRow[]>(() => {
    if (!trend.data) return [];
    return trend.data.buckets.map((b) => ({
      ...b,
      label: bucketLabel(b, trend.data!.bucketGranularity),
      claudeFullTokens: includeCache
        ? b.claudeTokens
        : Math.max(0, b.claudeTokens - b.claudeCacheReadInputTokens),
      codexFullTokens: b.codexTokens,
    }));
  }, [trend.data, includeCache]);

  // Totals + 环比 under the cache toggle. Raw totals still feed the
  // "Claude 输入构成" explainer; everything aggregate uses the effective view.
  const effectiveTotals = useMemo(
    () => (trend.data ? deriveTotals(trend.data.totals, includeCache) : null),
    [trend.data, includeCache]
  );
  const effectivePrevTotal =
    trend.data?.mode === "window"
      ? includeCache
        ? trend.data.previousWindowTotal
        : Math.max(
            0,
            trend.data.previousWindowTotal -
              trend.data.previousWindowClaudeCacheReadInputTokens
          )
      : 0;
  const effectiveDeltaRatio =
    effectiveTotals && effectivePrevTotal > 0
      ? (effectiveTotals.totalTokens - effectivePrevTotal) / effectivePrevTotal
      : null;

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
              已排除 Claude 命中 cache（每轮重放的缓存）。总量、占比、拆分、柱状图与环比均按此口径；
              下方「Claude 输入构成」始终展示完整三段。
            </div>
          )}
          <section className="mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="窗口内总 token"
              value={formatTokenCount(effectiveTotals.totalTokens)}
              subtle={`${effectiveTotals.totalSessionCount} session`}
            />
            <StatCard
              label="Claude 占比"
              value={`${(effectiveTotals.claudeShare * 100).toFixed(1)}%`}
              subtle={formatTokenCount(effectiveTotals.claudeTokens)}
            />
            <StatCard
              label="Codex 占比"
              value={`${(effectiveTotals.codexShare * 100).toFixed(1)}%`}
              subtle={formatTokenCount(effectiveTotals.codexTokens)}
            />
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

          <BreakdownMatrix totals={effectiveTotals} includeCache={includeCache} />

          <ClaudeInputComposition totals={trend.data.totals} />

          <CodexOutputComposition totals={trend.data.totals} />

          <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--fg)]">
                {isMonthMode
                  ? `${trend.data.mode === "month" ? trend.data.monthKey : ""} 按天分布`
                  : `${WINDOWS.find((w) => w.value === currentWindow)?.label} 趋势`}
              </h2>
              <div className="flex items-center gap-3 text-xs text-[var(--fg-muted)]">
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "#d97757" }} />
                  Claude
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "#2563eb" }} />
                  Codex
                </span>
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
                    tickFormatter={(v: number) => formatTokenCount(v)}
                    width={50}
                  />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
                  <Bar dataKey="claudeFullTokens" stackId="tokens" fill="#d97757" radius={0} />
                  <Bar dataKey="codexFullTokens" stackId="tokens" fill="#2563eb" radius={0} />
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
