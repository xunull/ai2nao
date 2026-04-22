import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api";
import type { GhTagHeatmapRes, TagHeatmapGrain } from "../types/github";

type Props = {
  grain: TagHeatmapGrain;
  from: string | null;
  to: string | null;
  includeLanguageFallback: boolean;
  topN?: number;
  /** Selected tags propagate into highlight and row click-to-toggle. */
  selectedTags: string[];
  onToggleTag: (tag: string) => void;
};

const ROW_H = 18;
const CELL_W = 20;
const LEFT_GUTTER = 140;
const TOP_GUTTER = 22;

/**
 * 2D tag × time heatmap. This is NOT the same shape as the calendar
 * `GithubHeatmap`; only the 5-step green color ramp is shared. Layout is
 * a matrix with tag rows (clickable to toggle selection), time columns
 * (axis labels shown at a sparse stride so they don't collide), and
 * cells whose fill encodes count intensity.
 *
 * Color choice: sequential green ramp, ratio against the matrix max rather
 * than per-row or per-column. The user's mental model is "which tags were
 * hot overall, and when", which requires a global scale.
 */
export function TagTimeHeatmap({
  grain,
  from,
  to,
  includeLanguageFallback,
  topN = 15,
  selectedTags,
  onToggleTag,
}: Props) {
  const qs = new URLSearchParams();
  qs.set("grain", grain);
  qs.set("top", String(topN));
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (includeLanguageFallback) qs.set("include_language", "1");

  const url = `/api/github/tags/heatmap?${qs.toString()}`;

  const q = useQuery({
    queryKey: ["gh-tags-heatmap", grain, from, to, includeLanguageFallback, topN],
    queryFn: () => apiGet<GhTagHeatmapRes>(url),
  });

  const { xs, ys, cells, maxCell } = useMemo(() => {
    const data = q.data;
    if (!data) return { xs: [], ys: [], cells: [], maxCell: 1 };
    let m = 0;
    for (const row of data.cells) {
      for (const v of row) if (v > m) m = v;
    }
    return {
      xs: data.xs,
      ys: data.ys,
      cells: data.cells,
      maxCell: Math.max(1, m),
    };
  }, [q.data]);

  const selectedSet = useMemo(
    () => new Set(selectedTags.map((t) => t.toLowerCase())),
    [selectedTags]
  );

  if (q.isLoading) {
    return (
      <section className="rounded border border-[var(--border)] bg-white p-4 shadow-sm">
        <h2 className="text-sm font-medium mb-2">Tag × 时间</h2>
        <p className="text-xs text-[var(--muted)]">加载热力图…</p>
      </section>
    );
  }
  if (q.isError) {
    return (
      <section className="rounded border border-[var(--border)] bg-white p-4 shadow-sm">
        <h2 className="text-sm font-medium mb-2">Tag × 时间</h2>
        <p className="text-xs text-red-600">
          {String((q.error as Error)?.message ?? "加载失败")}
        </p>
      </section>
    );
  }
  if (xs.length === 0 || ys.length === 0) {
    return (
      <section className="rounded border border-[var(--border)] bg-white p-4 shadow-sm">
        <h2 className="text-sm font-medium mb-2">Tag × 时间</h2>
        <p className="text-xs text-[var(--muted)]">
          当前筛选下无数据。调整时间窗或切换粒度。
        </p>
      </section>
    );
  }

  // Label every column at high density is noisy; pick a stride so ~10 labels
  // fit across the axis regardless of column count.
  const labelStride = Math.max(1, Math.ceil(xs.length / 12));
  const width = LEFT_GUTTER + xs.length * CELL_W + 8;
  const height = TOP_GUTTER + ys.length * ROW_H + 8;

  function colorFor(v: number): string {
    if (v === 0) return "#ebedf0";
    const ratio = v / maxCell;
    if (ratio < 0.2) return "#c6e48b";
    if (ratio < 0.45) return "#7bc96f";
    if (ratio < 0.75) return "#239a3b";
    return "#196127";
  }

  return (
    <section className="rounded border border-[var(--border)] bg-white p-4 shadow-sm overflow-x-auto">
      <header className="flex items-center justify-between gap-4 mb-2">
        <h2 className="text-sm font-medium">
          Tag × 时间 <span className="text-[var(--muted)]">（点 tag 名筛选）</span>
        </h2>
        <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
          <span>少</span>
          <span
            className="inline-block w-3 h-3 rounded-sm"
            style={{ background: "#ebedf0" }}
          />
          <span
            className="inline-block w-3 h-3 rounded-sm"
            style={{ background: "#c6e48b" }}
          />
          <span
            className="inline-block w-3 h-3 rounded-sm"
            style={{ background: "#7bc96f" }}
          />
          <span
            className="inline-block w-3 h-3 rounded-sm"
            style={{ background: "#239a3b" }}
          />
          <span
            className="inline-block w-3 h-3 rounded-sm"
            style={{ background: "#196127" }}
          />
          <span>多</span>
        </div>
      </header>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="Tag × time heatmap"
      >
        {/* x-axis labels */}
        <g transform={`translate(${LEFT_GUTTER}, ${TOP_GUTTER - 6})`}>
          {xs.map((x, j) =>
            j % labelStride === 0 ? (
              <text
                key={x}
                x={j * CELL_W + CELL_W / 2}
                y={0}
                fontSize="9"
                fill="#6b7280"
                textAnchor="middle"
              >
                {x}
              </text>
            ) : null
          )}
        </g>
        {/* y-axis tag labels (clickable) */}
        <g transform={`translate(0, ${TOP_GUTTER})`}>
          {ys.map((tag, i) => {
            const selected = selectedSet.has(tag.toLowerCase());
            return (
              <g key={tag} transform={`translate(0, ${i * ROW_H})`}>
                <rect
                  x={0}
                  y={0}
                  width={LEFT_GUTTER - 4}
                  height={ROW_H - 2}
                  fill={selected ? "#e0f2fe" : "transparent"}
                  stroke={selected ? "#0369a1" : "transparent"}
                  rx={3}
                />
                <text
                  x={6}
                  y={ROW_H / 2 + 4}
                  fontSize="11"
                  fill={selected ? "#0c4a6e" : "#111827"}
                  style={{ cursor: "pointer", userSelect: "none" }}
                  onClick={() => onToggleTag(tag)}
                >
                  {tag}
                </text>
              </g>
            );
          })}
        </g>
        {/* cells */}
        <g transform={`translate(${LEFT_GUTTER}, ${TOP_GUTTER})`}>
          {cells.map((row, i) =>
            row.map((v, j) => (
              <rect
                key={`${i}-${j}`}
                x={j * CELL_W}
                y={i * ROW_H}
                width={CELL_W - 2}
                height={ROW_H - 2}
                rx={2}
                fill={colorFor(v)}
              >
                <title>
                  {ys[i]} @ {xs[j]}: {v}
                </title>
              </rect>
            ))
          )}
        </g>
      </svg>
    </section>
  );
}
