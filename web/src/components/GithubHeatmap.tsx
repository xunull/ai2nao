import { useMemo } from "react";
import type { GhHeatmapBucket } from "../types/github";

type Props = {
  buckets: GhHeatmapBucket[];
  selected: string | null;
  onSelect: (day: string | null) => void;
  /** Show N columns ending today. 53 ≈ one year. */
  weeks?: number;
};

const CELL = 12;
const GAP = 2;
const ROW_H = CELL + GAP;
const COL_W = CELL + GAP;

/**
 * GitHub-style contribution heatmap, hand-rolled in SVG (zero deps).
 * Cell = 1 day; column = 1 ISO week starting Sunday. Colour encodes the
 * COMBINED activity (repo creations + stars) on that day because the user's
 * "panorama" is about self-output + interest in aggregate, not two
 * separate colour scales.
 *
 * Clicking a non-empty cell selects that day; clicking an empty cell or
 * re-clicking the selected cell clears the filter. The selection is owned
 * by the parent so the card stream can filter itself.
 */
export function GithubHeatmap({ buckets, selected, onSelect, weeks = 53 }: Props) {
  const { grid, totalWeeks, monthLabels } = useMemo(() => {
    const byDay = new Map<string, GhHeatmapBucket>();
    for (const b of buckets) byDay.set(b.day, b);
    const today = new Date();
    const todayDow = today.getDay();
    const daysInGrid = weeks * 7;
    const endOfLastWeek = new Date(today);
    endOfLastWeek.setDate(today.getDate() + (6 - todayDow));
    const start = new Date(endOfLastWeek);
    start.setDate(endOfLastWeek.getDate() - daysInGrid + 1);

    type Cell = {
      day: string;
      repo_count: number;
      star_count: number;
      total: number;
      inFuture: boolean;
    };
    const cells: Cell[] = [];
    for (let i = 0; i < daysInGrid; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const bucket = byDay.get(iso);
      const repo = bucket?.repo_count ?? 0;
      const star = bucket?.star_count ?? 0;
      cells.push({
        day: iso,
        repo_count: repo,
        star_count: star,
        total: repo + star,
        inFuture: d > today,
      });
    }

    const grid: Cell[][] = [];
    for (let w = 0; w < weeks; w++) {
      grid.push(cells.slice(w * 7, w * 7 + 7));
    }

    const monthLabels: { colIndex: number; label: string }[] = [];
    let lastMonth = -1;
    for (let w = 0; w < grid.length; w++) {
      const firstCell = grid[w][0];
      const d = new Date(firstCell.day);
      const m = d.getMonth();
      if (m !== lastMonth) {
        monthLabels.push({
          colIndex: w,
          label: d.toLocaleString(undefined, { month: "short" }),
        });
        lastMonth = m;
      }
    }

    return { grid, totalWeeks: grid.length, monthLabels };
  }, [buckets, weeks]);

  const maxTotal = useMemo(() => {
    let m = 0;
    for (const row of grid) {
      for (const cell of row) {
        if (cell.total > m) m = cell.total;
      }
    }
    return Math.max(1, m);
  }, [grid]);

  function colorFor(total: number, inFuture: boolean): string {
    if (inFuture) return "#f3f4f6";
    if (total === 0) return "#ebedf0";
    const ratio = total / maxTotal;
    if (ratio < 0.25) return "#c6e48b";
    if (ratio < 0.5) return "#7bc96f";
    if (ratio < 0.75) return "#239a3b";
    return "#196127";
  }

  const width = totalWeeks * COL_W + 30;
  const height = 7 * ROW_H + 20;

  const dayLetters = ["日", "一", "二", "三", "四", "五", "六"];

  return (
    <div className="rounded border border-[var(--border)] bg-white p-4 shadow-sm overflow-x-auto">
      <div className="flex items-center justify-between gap-4 mb-2">
        <h2 className="text-sm font-medium">日历热力图</h2>
        <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
          <span>少</span>
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: "#ebedf0" }} />
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: "#c6e48b" }} />
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: "#7bc96f" }} />
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: "#239a3b" }} />
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: "#196127" }} />
          <span>多</span>
        </div>
      </div>
      <svg width={width} height={height} role="img" aria-label="GitHub activity heatmap">
        <g transform="translate(30, 0)">
          {monthLabels.map((m) => (
            <text
              key={`${m.colIndex}-${m.label}`}
              x={m.colIndex * COL_W}
              y={10}
              fontSize="10"
              fill="#6b7280"
            >
              {m.label}
            </text>
          ))}
        </g>
        <g transform="translate(0, 18)">
          {dayLetters.map((letter, i) => (
            <text
              key={letter}
              x={0}
              y={i * ROW_H + CELL - 2}
              fontSize="9"
              fill="#9ca3af"
            >
              {letter}
            </text>
          ))}
        </g>
        <g transform="translate(30, 18)">
          {grid.map((col, w) =>
            col.map((cell, d) => {
              const isSelected = selected === cell.day;
              const clickable = !cell.inFuture;
              return (
                <g key={cell.day}>
                  <rect
                    x={w * COL_W}
                    y={d * ROW_H}
                    width={CELL}
                    height={CELL}
                    rx={2}
                    ry={2}
                    fill={colorFor(cell.total, cell.inFuture)}
                    stroke={isSelected ? "#1e3a8a" : "transparent"}
                    strokeWidth={isSelected ? 2 : 0}
                    style={{ cursor: clickable ? "pointer" : "default" }}
                    onClick={() => {
                      if (!clickable) return;
                      onSelect(isSelected ? null : cell.day);
                    }}
                  >
                    <title>
                      {cell.day}: {cell.repo_count} 个 repo 创建 · {cell.star_count} 个 star
                    </title>
                  </rect>
                </g>
              );
            })
          )}
        </g>
      </svg>
      {selected ? (
        <div className="mt-2 text-xs text-[var(--muted)] flex items-center gap-2">
          <span>已筛选：{selected}</span>
          <button
            type="button"
            className="rounded border border-[var(--border)] px-2 py-0.5 hover:bg-neutral-50"
            onClick={() => onSelect(null)}
          >
            清除
          </button>
        </div>
      ) : null}
    </div>
  );
}
