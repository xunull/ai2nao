import type Database from "better-sqlite3";
import { enumerateAndAggregate } from "../workTokensTrend/service.js";
import { getTopicStreamMatrix } from "../topicStream/queries.js";
import {
  WORK_RECAP_TOPIC_TOP_N,
  WORK_RECAP_DRIFT_MIN_EVENTS,
  type WorkRecapFactGroup,
  type WorkRecapTokenFacts,
  type WorkRecapTopicFacts,
  type WorkRecapTopicSourceTop,
  type WorkRecapTopicDriftItem,
  type WorkRecapTopicShare,
} from "./types.js";

/**
 * v2 multi-source facts. Two independent, degradable fact groups folded into
 * WorkRecapFacts by the service (which owns the db + window). Each returns a
 * status-tagged group ('ok' | 'absent' | 'empty' | 'error') so the LLM can tell
 * "genuinely $0 / no activity" (empty) from "source not available" (absent /
 * error). Design: quincy-main-design-20260712 + Assignment Findings.
 */

// ---- token / cost ----------------------------------------------------------

/** Token + priced-cost facts for the window. Reuses the workbench totals pipeline. */
export function gatherTokenFacts(
  db: Database.Database,
  windowStart: Date,
  windowEnd: Date
): WorkRecapFactGroup<WorkRecapTokenFacts> {
  try {
    const { totals } = enumerateAndAggregate(db, windowStart, windowEnd, "day");
    if (totals.totalSessionCount === 0 && totals.totalTokens === 0) {
      return { status: "empty" };
    }
    const shares: Array<["claude" | "codex" | "minimax", number]> = [
      ["claude", totals.claudeShare],
      ["codex", totals.codexShare],
      ["minimax", totals.minimaxShare],
    ];
    const dominant = shares.reduce((a, b) => (b[1] > a[1] ? b : a));
    // Headline caliber = input+output MINUS cache (matches the workbench headline;
    // cache_read can dwarf real work by ~8x, so totalTokens would mislead).
    const headlineTokens =
      totals.claudeInputTokens -
      totals.claudeCacheReadInputTokens -
      totals.claudeCacheCreationInputTokens +
      totals.claudeOutputTokens +
      (totals.codexInputTokens - totals.codexCachedInputTokens) +
      totals.codexOutputTokens +
      (totals.minimaxInputTokens -
        totals.minimaxCacheReadInputTokens -
        totals.minimaxCacheCreationInputTokens) +
      totals.minimaxOutputTokens;
    return {
      status: "ok",
      data: {
        costUsd: totals.totalCostUsd,
        coverage: totals.coverage,
        unpricedTokenCount: totals.unpricedTokenCount,
        priceSnapshotDate: totals.priceSnapshotDate,
        headlineTokens: Math.max(0, headlineTokens),
        dominantProvider: totals.totalTokens === 0 ? "none" : dominant[0],
        claudeShare: totals.claudeShare,
        codexShare: totals.codexShare,
      },
    };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

// ---- topics (per-source top + gated drift) ---------------------------------

const TOPIC_SOURCES: { source: "chrome" | "git" | "conversation"; profile: string }[] = [
  { source: "chrome", profile: "Default" },
  { source: "git", profile: "-" },
  { source: "conversation", profile: "-" },
];

/** "其他" is a catch-all (all sources); the rest are chrome generic-browsing noise. */
const TOPIC_NOISE_ALL = new Set(["其他"]);
const CHROME_GENERIC = new Set([
  "其他", "论坛·社区", "社区", "搜索", "地图", "视频·娱乐", "资讯·阅读", "工具·云控制台",
]);

function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const nd = new Date(y!, m! - 1, d! + n);
  return localDay(nd);
}

/** Column j's top category index (argmax over categories at that day bucket). */
function topCatAtBucket(ys: string[], cells: number[][], j: number, drop: Set<string>): string | null {
  let best = -1;
  let bestVal = 0;
  for (let i = 0; i < ys.length; i++) {
    if (drop.has(ys[i]!)) continue;
    const v = cells[i]?.[j] ?? 0;
    if (v > bestVal) { bestVal = v; best = i; }
  }
  return best >= 0 ? ys[best]! : null;
}

export function gatherTopicDriftFacts(
  db: Database.Database,
  windowStart: Date,
  windowEnd: Date
): WorkRecapFactGroup<WorkRecapTopicFacts> {
  try {
    const from = localDay(windowStart);
    const to = addDays(localDay(windowEnd), 1); // matrix is `< to` exclusive → include windowEnd's day
    const bySource: WorkRecapTopicSourceTop[] = [];
    const drift: WorkRecapTopicDriftItem[] = [];

    for (const { source, profile } of TOPIC_SOURCES) {
      const m = getTopicStreamMatrix(db, { source, profile, grain: "day", from, to });
      if (m.xs.length === 0) continue; // this source absent in the window
      const drop = source === "chrome" ? CHROME_GENERIC : TOPIC_NOISE_ALL;

      // per-category totals over the window (rows are already total-desc sorted)
      const totalByCat = m.ys.map((name, i) => ({
        name,
        count: m.cells[i]!.reduce((a, b) => a + b, 0),
      }));
      const events = totalByCat.reduce((a, c) => a + c.count, 0);
      const grand = events || 1;
      const top: WorkRecapTopicShare[] = totalByCat
        .filter((c) => !drop.has(c.name))
        .sort((a, b) => b.count - a.count)
        .slice(0, WORK_RECAP_TOPIC_TOP_N)
        .map((c) => ({ name: c.name, count: c.count, share: c.count / grand }));
      bySource.push({ source, events, top });

      // drift: gated on volume + >= 2 active day-buckets (weekly grain is noisy)
      if (events >= WORK_RECAP_DRIFT_MIN_EVENTS && m.xs.length >= 2) {
        const first = topCatAtBucket(m.ys, m.cells, 0, drop);
        const last = topCatAtBucket(m.ys, m.cells, m.xs.length - 1, drop);
        if (first && last && first !== last) drift.push({ source, from: first, to: last });
      }
    }

    if (bySource.length === 0) return { status: "empty" };
    return { status: "ok", data: { bySource, drift: drift.length ? drift : null } };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
