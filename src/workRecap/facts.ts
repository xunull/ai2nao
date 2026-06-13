import {
  COMMIT_TYPE_KINDS,
  type WorkRecapCommit,
  type WorkRecapCommitTypeKind,
  type WorkRecapDailyBucket,
  type WorkRecapDiagnostic,
  type WorkRecapFacts,
  type WorkRecapProjectShare,
  type WorkRecapWindow,
  type WorkRecapDegradeReason,
} from "./types.js";

function emptyCommitTypeCounts(): Record<WorkRecapCommitTypeKind, number> {
  return COMMIT_TYPE_KINDS.reduce(
    (acc, k) => {
      acc[k] = 0;
      return acc;
    },
    {} as Record<WorkRecapCommitTypeKind, number>
  );
}

function localDayKey(date: Date): string {
  // YYYY-MM-DD in the local time zone (consistent with daily-summary semantics).
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function* iterateLocalDays(start: Date, end: Date): Generator<string> {
  // Walk start..end inclusive at local midnight boundaries.
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const stop = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cursor.getTime() <= stop.getTime()) {
    yield localDayKey(cursor);
    cursor.setDate(cursor.getDate() + 1);
  }
}

export type ComputeFactsArgs = {
  commits: WorkRecapCommit[];
  windowKey: WorkRecapWindow;
  windowStart: Date;
  windowEnd: Date;
  authorEmail: string;
  reposScanned: number;
  reposTotal: number;
  scanTruncated: boolean;
  scanTruncatedReason: WorkRecapDegradeReason | null;
  scanDiagnostics: WorkRecapDiagnostic[];
};

/**
 * Pure deterministic facts calculation. Input = parsed commits + scan
 * meta; output = the structured fact layer. Never calls LLM, never throws.
 *
 * The output shape mirrors WorkRecapFacts; the LLM only ever sees this and
 * cannot conjure projects or counts not present here.
 */
export function computeFacts(args: ComputeFactsArgs): WorkRecapFacts {
  const commitTypeCounts = emptyCommitTypeCounts();
  const projectAgg = new Map<
    string,
    { label: string; count: number }
  >();
  const dailyAgg = new Map<string, number>();

  for (const c of args.commits) {
    commitTypeCounts[c.kind] += 1;
    const proj = projectAgg.get(c.repoPath);
    if (proj) {
      proj.count += 1;
    } else {
      projectAgg.set(c.repoPath, { label: c.repoLabel, count: 1 });
    }
    const dayKey = localDayKey(c.committedAt);
    dailyAgg.set(dayKey, (dailyAgg.get(dayKey) ?? 0) + 1);
  }

  const totalCommits = args.commits.length;
  const projectShare: WorkRecapProjectShare[] = Array.from(projectAgg.entries())
    .map(([projectKey, { label, count }]) => ({
      projectKey,
      projectLabel: label,
      commitCount: count,
      share: totalCommits === 0 ? 0 : count / totalCommits,
    }))
    .sort((a, b) => b.commitCount - a.commitCount);

  // Ensure every day in the window has a bucket (zeroes included) so the UI
  // can render a contiguous timeline without per-call zero-fill logic.
  const dailyCounts: WorkRecapDailyBucket[] = [];
  for (const dayKey of iterateLocalDays(args.windowStart, args.windowEnd)) {
    dailyCounts.push({ date: dayKey, commitCount: dailyAgg.get(dayKey) ?? 0 });
  }

  return {
    windowKey: args.windowKey,
    windowStart: args.windowStart.toISOString(),
    windowEnd: args.windowEnd.toISOString(),
    authorEmail: args.authorEmail,
    totalCommits,
    projectCount: projectAgg.size,
    projectShare,
    commitTypeCounts,
    dailyCounts,
    reposScanned: args.reposScanned,
    reposTotal: args.reposTotal,
    scanTruncated: args.scanTruncated,
    scanTruncatedReason: args.scanTruncatedReason,
    diagnostics: args.scanDiagnostics,
  };
}

/** Heuristic threshold below which we mark the inference layer as low_signal. */
export const SPARSE_SIGNAL_COMMIT_THRESHOLD = 3;

/** Pure helper for tests + prompt to detect sparse-signal windows. */
export function isSparseFacts(facts: WorkRecapFacts): boolean {
  return facts.totalCommits < SPARSE_SIGNAL_COMMIT_THRESHOLD;
}
