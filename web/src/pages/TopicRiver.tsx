import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { Page } from "../components/Page";
import { exportElementToPng } from "../util/exportPng";

// Browsing Topic River (Stage 1): a hand-rolled SVG streamgraph of browsing
// attention by category over time. Layout B (design review): left category
// index (keyboard path) + right river. Stable band order, 其他 pinned bottom
// muted. Read-only — rebuild is CLI-only in Stage 1.

const OTHER_CATEGORY = "其他";
const OTHER_COLOR = "#8a8f98";
const FALLBACK_PALETTE = [
  "#4f9dff",
  "#3fb98f",
  "#a06bff",
  "#e0a33a",
  "#ff8a5c",
  "#c98bdb",
  "#6c9fb8",
  "#e5688a",
  "#5ec8a0",
  "#d98a5a",
];
type Grain = "day" | "week" | "month";

type TopicStatus = {
  ruleVersion: string;
  state: {
    last_rebuilt_at: string | null;
    last_error: string | null;
    source_event_count: number;
    derived_event_count: number;
  } | null;
  fresh: boolean;
  staleReasons: string[];
};

type StreamRes = {
  source: string;
  profile: string;
  grain: Grain;
  xs: string[];
  ys: string[];
  cells: number[][];
  status: TopicStatus;
};

type CategoriesRes = {
  configOk: boolean;
  configPath: string;
  configExists?: boolean;
  issues?: { path: string; message: string }[];
  categories: { name: string; color: string }[];
};

type Pt = { x: number; y: number };

function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return localDay(d);
}

function defaultTo(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1); // exclusive upper bound
  return localDay(d);
}

function parseGrain(raw: string | null): Grain {
  return raw === "week" || raw === "month" ? raw : "day";
}

/** Catmull-Rom → cubic-bezier curve commands for a point list (no leading M). */
function curveCommands(points: Pt[]): string {
  if (points.length < 2) return "";
  const parts: string[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    parts.push(
      `C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)} ${cp2x.toFixed(2)} ${cp2y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`
    );
  }
  return parts.join(" ");
}

function bandPath(top: Pt[], bottom: Pt[]): string {
  if (top.length === 0) return "";
  if (top.length === 1) {
    // Degenerate single-bucket: a thin closed sliver.
    return `M ${top[0].x} ${top[0].y} L ${bottom[0].x} ${bottom[0].y} Z`;
  }
  const head = `M ${top[0].x.toFixed(2)} ${top[0].y.toFixed(2)} ${curveCommands(top)}`;
  const join = `L ${bottom[0].x.toFixed(2)} ${bottom[0].y.toFixed(2)} ${curveCommands(bottom)}`;
  return `${head} ${join} Z`;
}

/** Stable band order: by total desc, but 其他 always last (bottom of the stack). */
function orderBands(ys: string[], cells: number[][]): { name: string; row: number[]; total: number }[] {
  const bands = ys.map((name, i) => ({
    name,
    row: cells[i] ?? [],
    total: (cells[i] ?? []).reduce((a, b) => a + b, 0),
  }));
  const other = bands.filter((b) => b.name === OTHER_CATEGORY);
  const rest = bands
    .filter((b) => b.name !== OTHER_CATEGORY)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return [...rest, ...other];
}

function colorFor(name: string, colorMap: Map<string, string>, index: number): string {
  if (name === OTHER_CATEGORY) return OTHER_COLOR;
  return colorMap.get(name) ?? FALLBACK_PALETTE[index % FALLBACK_PALETTE.length];
}

type BandLayout = {
  name: string;
  color: string;
  total: number;
  path: string;
  top: Pt[];
};

function Streamgraph({
  data,
  colorMap,
  selected,
  onSelect,
}: {
  data: StreamRes;
  colorMap: Map<string, string>;
  selected: string | null;
  onSelect: (name: string, bucket: string) => void;
}) {
  const [hover, setHover] = useState<{ band: string; bucket: number } | null>(null);

  const cell = 16; // px per time bucket
  const plotH = 420;
  const padTop = 24;
  const padBottom = 40;
  const padLeft = 8;
  const height = plotH + padTop + padBottom;
  const n = data.xs.length;
  const width = Math.max(560, padLeft * 2 + Math.max(n, 1) * cell);
  const plotLeft = padLeft;
  const plotW = width - padLeft * 2;
  const centerY = padTop + plotH / 2;

  const ordered = useMemo(() => orderBands(data.ys, data.cells), [data.ys, data.cells]);

  const { bands, xAt, totals } = useMemo(() => {
    const totals: number[] = [];
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (const b of ordered) s += b.row[j] ?? 0;
      totals.push(s);
    }
    const maxTotal = Math.max(1, ...totals);
    const yScale = (plotH - 16) / maxTotal;
    const xAt = (j: number): number => (n <= 1 ? plotLeft + plotW / 2 : plotLeft + (j / (n - 1)) * plotW);

    // Running cumulative offset (silhouette: centered on total/2 per bucket).
    const cursor = totals.map((t) => -t / 2);
    const bands: BandLayout[] = ordered.map((b, i) => {
      const top: Pt[] = [];
      const bottom: Pt[] = [];
      for (let j = 0; j < n; j++) {
        const v = b.row[j] ?? 0;
        const yTop = centerY + cursor[j] * yScale;
        const yBot = centerY + (cursor[j] + v) * yScale;
        top.push({ x: xAt(j), y: yTop });
        bottom.push({ x: xAt(j), y: yBot });
        cursor[j] += v;
      }
      bottom.reverse();
      return {
        name: b.name,
        color: colorFor(b.name, colorMap, i),
        total: b.total,
        path: bandPath(top, bottom),
        top,
      };
    });
    return { bands, xAt, totals };
  }, [ordered, n, plotW, plotLeft, plotH, centerY, colorMap]);

  // Sparse x-axis ticks (~7 labels).
  const tickEvery = Math.max(1, Math.ceil(n / 7));
  const bucketFromClientX = (e: React.MouseEvent<SVGPathElement>): number => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg || n <= 1) return 0;
    const rect = svg.getBoundingClientRect();
    const rel = ((e.clientX - rect.left) / rect.width) * width - plotLeft;
    const j = Math.round((rel / plotW) * (n - 1));
    return Math.min(n - 1, Math.max(0, j));
  };

  const hoverBand = hover ? bands.find((b) => b.name === hover.band) : null;
  const hoverCount =
    hover && hoverBand
      ? (ordered.find((b) => b.name === hover.band)?.row[hover.bucket] ?? 0)
      : 0;

  return (
    <div className="relative overflow-x-auto rounded border border-[var(--border)] bg-[var(--bg)]">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`浏览主题河流:${data.ys.length} 个类目随时间的访问量`}
      >
        {/* baseline */}
        <line
          x1={plotLeft}
          x2={plotLeft + plotW}
          y1={centerY}
          y2={centerY}
          stroke="var(--border)"
          strokeDasharray="2 4"
        />
        {bands.map((b) => {
          const dim = selected != null && selected !== b.name;
          const active = selected === b.name;
          return (
            <path
              key={b.name}
              d={b.path}
              fill={b.color}
              opacity={dim ? 0.22 : hover && hover.band !== b.name ? 0.5 : 0.92}
              stroke={active ? "var(--fg)" : "none"}
              strokeWidth={active ? 1 : 0}
              style={{ cursor: "pointer", transition: "opacity 120ms" }}
              onMouseMove={(e) => setHover({ band: b.name, bucket: bucketFromClientX(e) })}
              onMouseLeave={() => setHover(null)}
              onClick={(e) => onSelect(b.name, data.xs[hover ? hover.bucket : bucketFromClientX(e)])}
            >
              <title>{`${b.name} · 共 ${b.total} 次`}</title>
            </path>
          );
        })}
        {/* x-axis tick labels */}
        {data.xs.map((x, j) =>
          j % tickEvery === 0 ? (
            <text
              key={x}
              x={xAt(j)}
              y={height - 14}
              textAnchor="middle"
              className="fill-[var(--muted)]"
              fontSize={11}
            >
              {x.length > 7 ? x.slice(5) : x}
            </text>
          ) : null
        )}
        {/* hover guide */}
        {hover ? (
          <line
            x1={xAt(hover.bucket)}
            x2={xAt(hover.bucket)}
            y1={padTop}
            y2={padTop + plotH}
            stroke="var(--fg)"
            strokeOpacity={0.25}
          />
        ) : null}
      </svg>
      {hover && hoverBand ? (
        <div className="pointer-events-none absolute left-2 top-2 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs shadow-sm">
          <span
            className="mr-1 inline-block h-2 w-2 rounded-sm align-middle"
            style={{ background: hoverBand.color }}
          />
          <span className="font-medium">{hover.band}</span>
          <span className="mx-1 text-[var(--muted)]">·</span>
          <span className="text-[var(--muted)]">{data.xs[hover.bucket]}</span>
          <span className="mx-1 text-[var(--muted)]">·</span>
          <span>{hoverCount} 次</span>
        </div>
      ) : null}
    </div>
  );
}

function statusBadge(
  configOk: boolean,
  status?: TopicStatus
): { text: string; cls: string } {
  if (!configOk) {
    return { text: "配置错误", cls: "border-red-300 bg-red-50 text-red-800" };
  }
  if (!status?.state) {
    return { text: "未构建", cls: "border-amber-300 bg-amber-50 text-amber-800" };
  }
  if (status.state.last_error) {
    return { text: "重建失败", cls: "border-red-300 bg-red-50 text-red-800" };
  }
  if (!status.fresh) {
    return { text: "可能过期", cls: "border-amber-300 bg-amber-50 text-amber-800" };
  }
  return { text: "新鲜", cls: "border-emerald-300 bg-emerald-50 text-emerald-800" };
}

function reasonText(reason: string): string {
  const map: Record<string, string> = {
    not_built: "尚未构建主题河流",
    rule_version_mismatch: "分类词表已更新,需要重建",
    last_rebuild_error: "上次重建失败",
    source_count_changed: "原始访问数已变化",
    derived_count_changed: "派生记录数已变化",
  };
  return map[reason] ?? reason;
}

export function TopicRiver() {
  const [params, setParams] = useSearchParams();
  const grain = parseGrain(params.get("grain"));
  const from = params.get("from") || defaultFrom();
  const to = params.get("to") || defaultTo();
  const cat = params.get("cat");
  const bucket = params.get("bucket");
  const source = params.get("source") === "git" ? "git" : "chrome";
  const profile = source === "git" ? "-" : params.get("profile") || "Default";
  const rebuildCmd = `node dist/cli.js topics rebuild --source ${source}`;

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value == null || value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const setSelection = (catVal: string | null, bucketVal: string | null) => {
    const next = new URLSearchParams(params);
    if (catVal) next.set("cat", catVal);
    else next.delete("cat");
    if (catVal && bucketVal) next.set("bucket", bucketVal);
    else next.delete("bucket");
    setParams(next, { replace: true });
  };

  const categoriesQuery = useQuery({
    queryKey: ["topics-categories"],
    queryFn: ({ signal }) => apiGet<CategoriesRes>("/api/topics/categories", { signal }),
  });

  const streamQuery = useQuery({
    queryKey: ["topics-stream", source, profile, grain, from, to],
    queryFn: ({ signal }) => {
      const q = new URLSearchParams({ source, profile, grain, from, to });
      return apiGet<StreamRes>(`/api/topics/stream?${q.toString()}`, { signal });
    },
  });

  const colorMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categoriesQuery.data?.categories ?? []) m.set(c.name, c.color);
    return m;
  }, [categoriesQuery.data]);

  const stream = streamQuery.data;
  const status = stream?.status;
  // Taxonomy config only applies to chrome; git has no config.
  const configOk = source === "chrome" ? categoriesQuery.data?.configOk ?? true : true;
  const badge = statusBadge(configOk, status);
  const riverRef = useRef<HTMLDivElement>(null);
  const hasRiver = !!(stream && stream.xs.length > 0);
  const exportPng = () => {
    if (riverRef.current) void exportElementToPng(riverRef.current, `topic-river-${grain}.png`);
  };

  // Left index rows: categories present in the matrix, stable order, 其他 last.
  const indexRows = useMemo(() => {
    if (!stream) return [];
    const ordered = orderBands(stream.ys, stream.cells);
    const max = Math.max(1, ...ordered.map((b) => b.total));
    return ordered.map((b, i) => ({
      name: b.name,
      total: b.total,
      color: colorFor(b.name, colorMap, i),
      share: b.total / max,
    }));
  }, [stream, colorMap]);

  const grainBtn = (g: Grain, label: string) => (
    <button
      type="button"
      onClick={() => setParam("grain", g)}
      className={`px-2.5 py-1 text-sm ${
        grain === g ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--fg)]"
      }`}
    >
      {label}
    </button>
  );

  const sourceBtn = (s: "chrome" | "git", label: string) => (
    <button
      type="button"
      onClick={() => {
        const next = new URLSearchParams(params);
        next.set("source", s);
        next.delete("cat");
        next.delete("bucket");
        setParams(next, { replace: true });
      }}
      className={`px-2.5 py-1 text-sm ${
        source === s ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--fg)]"
      }`}
    >
      {label}
    </button>
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-3 pb-3 text-sm">
      <div className="inline-flex overflow-hidden rounded border border-[var(--border)]">
        {sourceBtn("chrome", "浏览主题")}
        {sourceBtn("git", "git 提交")}
      </div>
      <div className="inline-flex overflow-hidden rounded border border-[var(--border)]">
        {grainBtn("day", "日")}
        {grainBtn("week", "周")}
        {grainBtn("month", "月")}
      </div>
      <label className="flex items-center gap-1 text-[var(--muted)]">
        从
        <input
          type="date"
          value={from}
          onChange={(e) => setParam("from", e.target.value)}
          className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-[var(--fg)]"
        />
      </label>
      <label className="flex items-center gap-1 text-[var(--muted)]">
        到
        <input
          type="date"
          value={to}
          onChange={(e) => setParam("to", e.target.value)}
          className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-[var(--fg)]"
        />
      </label>
      {cat ? (
        <button
          type="button"
          onClick={() => setSelection(null, null)}
          className="rounded border border-[var(--border)] px-2 py-0.5 text-[var(--muted)] hover:text-[var(--fg)]"
        >
          清除选中「{cat}」{bucket ? ` · ${bucket}` : ""}
        </button>
      ) : null}
    </div>
  );

  const actions = (
    <>
      {hasRiver ? (
        <button
          type="button"
          onClick={exportPng}
          className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)] hover:text-[var(--fg)]"
        >
          导出 PNG
        </button>
      ) : null}
      <span className={`rounded border px-2 py-0.5 text-xs ${badge.cls}`}>{badge.text}</span>
    </>
  );

  return (
    <Page
      title={source === "git" ? "git 提交河流" : "浏览主题河流"}
      subtitle={
        source === "git"
          ? "按 repo 看提交随时间的流动"
          : "按主题类目看浏览注意力随时间的流动"
      }
      actions={actions}
      toolbar={toolbar}
    >
      {!configOk && categoriesQuery.data?.issues ? (
        <div className="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <p className="font-medium">分类配置有误({categoriesQuery.data.configPath}):</p>
          <ul className="mt-1 list-disc pl-5">
            {categoriesQuery.data.issues.map((it) => (
              <li key={it.path}>
                {it.path}: {it.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {status?.state && !status.fresh && status.staleReasons.length > 0 ? (
        <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          数据可能过期:{status.staleReasons.map(reasonText).join("、")}。终端重建:
          <code className="ml-1 rounded bg-white/60 px-1">{rebuildCmd}</code>
        </div>
      ) : null}

      {streamQuery.isLoading ? (
        <div className="grid grid-cols-[360px_minmax(0,1fr)] gap-6">
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-8 animate-pulse rounded bg-[var(--border)]/40" />
            ))}
          </div>
          <div className="h-[484px] animate-pulse rounded bg-[var(--border)]/30" />
        </div>
      ) : streamQuery.isError ? (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-3 text-sm text-red-800">
          <p>加载失败:{(streamQuery.error as Error).message}</p>
          <button
            type="button"
            onClick={() => streamQuery.refetch()}
            className="mt-2 rounded border border-red-300 px-2 py-0.5"
          >
            重试
          </button>
        </div>
      ) : !status?.state ? (
        <EmptyNotBuilt cmd={rebuildCmd} />
      ) : stream && stream.xs.length === 0 ? (
        <p className="rounded border border-[var(--border)] px-3 py-6 text-center text-sm text-[var(--muted)]">
          该时间范围无活动。放宽日期范围或切换粒度试试。
        </p>
      ) : stream ? (
        <div className="grid grid-cols-[360px_minmax(0,1fr)] items-start gap-6">
          <div className="rounded border border-[var(--border)]">
            <div className="border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)]">
              {source === "git" ? "仓库" : "类目"} · 点击可高亮
            </div>
            <ul>
              {indexRows.map((r) => {
                const active = cat === r.name;
                return (
                  <li key={r.name}>
                    <button
                      type="button"
                      onClick={() => setSelection(active ? null : r.name, null)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--border)]/20 ${
                        active ? "bg-[var(--accent)]/10" : ""
                      }`}
                    >
                      <span
                        className="h-3 w-3 shrink-0 rounded-sm"
                        style={{ background: r.color }}
                      />
                      <span className="min-w-0 flex-1 truncate" title={r.name}>
                        {r.name}
                      </span>
                      <span className="tabular-nums text-[var(--muted)]">{r.total}</span>
                      <span className="ml-2 hidden h-1.5 w-16 shrink-0 rounded bg-[var(--border)]/40 sm:block">
                        <span
                          className="block h-1.5 rounded"
                          style={{ width: `${Math.round(r.share * 100)}%`, background: r.color }}
                        />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="min-w-0">
            <div ref={riverRef}>
              <Streamgraph
                data={stream}
                colorMap={colorMap}
                selected={cat}
                onSelect={setSelection}
              />
            </div>
            {cat && bucket ? (
              <Drilldown
                source={source}
                profile={profile}
                category={cat}
                bucket={bucket}
                grain={grain}
              />
            ) : (
              <p className="mt-2 text-xs text-[var(--muted)]">
                {source === "git"
                  ? "点击色带某段 → 看那段时间该 repo 的提交。"
                  : "点击色带某段 → 看那段时间该主题下访问过的页面。"}
              </p>
            )}
          </div>
        </div>
      ) : null}
    </Page>
  );
}

type DrilldownRow = {
  source_ref: string;
  url: string | null;
  title: string | null;
  host: string | null;
  category: string;
  calendar_day: string;
  event_time_unix_ms: number;
};
type DrilldownRes = { items: DrilldownRow[]; next_cursor: string | null };

function Drilldown({
  source,
  profile,
  category,
  bucket,
  grain,
}: {
  source: string;
  profile: string;
  category: string;
  bucket: string;
  grain: Grain;
}) {
  const q = useInfiniteQuery({
    queryKey: ["topics-drilldown", source, profile, category, bucket, grain],
    queryFn: ({ signal, pageParam }) => {
      const p = new URLSearchParams({ source, profile, category, bucket, grain });
      if (pageParam) p.set("cursor", pageParam);
      return apiGet<DrilldownRes>(`/api/topics/stream/drilldown?${p.toString()}`, { signal });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mt-4 rounded border border-[var(--border)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2 text-sm">
        <span>
          <span className="font-medium">{category}</span>
          <span className="mx-1 text-[var(--muted)]">·</span>
          <span className="text-[var(--muted)]">{bucket}</span>
        </span>
        <span className="text-xs text-[var(--muted)]">{items.length} 条{q.hasNextPage ? "+" : ""}</span>
      </div>
      {q.isLoading ? (
        <div className="space-y-2 p-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-6 animate-pulse rounded bg-[var(--border)]/40" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-[var(--muted)]">
          {source === "git" ? "该 repo 在这段时间没有提交。" : "该主题在这段时间没有页面。"}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {items.map((r) => (
            <li key={r.source_ref} className="px-3 py-1.5 text-sm">
              <a
                href={r.url ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="block truncate text-[var(--accent)] hover:underline"
                title={r.url ?? undefined}
              >
                {r.title?.trim() || r.url}
              </a>
              <div className="flex gap-2 text-xs text-[var(--muted)]">
                <span className="truncate">{r.host}</span>
                <span className="ml-auto shrink-0 tabular-nums">
                  {new Date(r.event_time_unix_ms).toLocaleString()}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage ? (
        <div className="border-t border-[var(--border)] px-3 py-2 text-center">
          <button
            type="button"
            onClick={() => q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
            className="rounded border border-[var(--border)] px-3 py-0.5 text-xs text-[var(--muted)] hover:text-[var(--fg)]"
          >
            {q.isFetchingNextPage ? "加载中…" : "加载更多"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function EmptyNotBuilt({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(cmd).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="rounded border border-[var(--border)] px-4 py-10 text-center">
      <p className="text-sm">主题河流尚未构建。</p>
      <p className="mt-1 text-sm text-[var(--muted)]">在终端运行下面的命令后刷新本页:</p>
      <div className="mt-3 inline-flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5">
        <code className="text-sm">{cmd}</code>
        <button
          type="button"
          onClick={copy}
          className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)] hover:text-[var(--fg)]"
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
    </div>
  );
}
