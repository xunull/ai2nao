/**
 * Decides what is worth interrupting a human for.
 *
 * Pure functions on purpose. Everything here is a judgement call about someone's
 * attention, which makes it the part most likely to be wrong and most expensive
 * to get wrong — so it lives where it can be tested exhaustively, with no Electron
 * and no I/O anywhere near it. The shell's job is reduced to calling these and
 * handing the result to `new Notification()`.
 *
 * ## Where the rules came from
 *
 * Measured on a real ai2nao install (2026-07-29), not chosen by taste:
 *
 * | observation                                        | rule it forced                |
 * |----------------------------------------------------|-------------------------------|
 * | 68,184 scheduled runs in 30 days                    | never notify on `success`     |
 * | cursor/vscode/git.line_churn/mac_apps: 100% `partial`, 0 success | never notify on `partial` |
 * | 8 `failed` runs all-time                            | always notify on `failed`     |
 * | 3 failures of one task inside 2 minutes             | cooldown per task             |
 * | 63 manual triggers all-time                         | notify when a manual run lands|
 * | provider_usage rows with remaining_percent = null   | ignore non-quota rows         |
 *
 * "Notify when status !== success" looks reasonable and would fire roughly 70
 * times a day for four tasks that are working exactly as designed. That is the
 * trap this table exists to document.
 *
 * The stake is not comfort. A shell that is annoying on day one gets muted, and a
 * muted shell cannot answer the question it was built to answer: does always-on
 * change how often you actually use this?
 */

import type { ScheduledTaskRunStatus } from "../scheduler/types.js";

/** Remaining-quota percentage at or below which we speak up. */
export const QUOTA_LOW_PERCENT = 20;

/**
 * Remaining-quota percentage you must climb back above before the same item can
 * alert again. The gap between this and QUOTA_LOW_PERCENT is what stops a value
 * oscillating around the threshold from firing on every crossing.
 */
export const QUOTA_CLEAR_PERCENT = 30;

/** One alert per failing task per window. Sized from the 2-minute failure burst. */
export const FAILURE_COOLDOWN_MS = 30 * 60_000;

/**
 * How many rows the shell asks for per poll. If a poll's oldest row is newer than
 * what we last saw, more than this many runs happened while we were not looking
 * and we cannot prove we saw everything in between.
 */
export const RUN_PAGE_SIZE = 50;

/** A row from `scheduled_task_runs`, camelCased at the boundary. */
export type RunRow = {
  id: number;
  taskKey: string;
  status: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  errorSummary: string | null;
};

/** A row from `provider_usage`. `remainingPercent` is null for non-quota rows. */
export type QuotaItem = {
  provider: string;
  itemKey: string;
  label: string;
  remainingPercent: number | null;
};

export type NotificationKind = "task-failed" | "manual-done" | "quota-low";

export type ShellNotification = {
  kind: NotificationKind;
  title: string;
  body: string;
};

export type NotifyState = {
  /**
   * Highest run id already accounted for. `null` means "never polled" — the next
   * poll establishes a baseline in silence rather than replaying ~100k rows of
   * history at someone who just opened the app for the first time.
   */
  lastSeenRunId: number | null;
  /** cooldown key → ISO timestamp we last alerted. Pruned as it goes. */
  lastFiredAt: Record<string, string>;
  /** `provider:itemKey` currently latched low, so it does not re-alert. */
  quotaLatched: string[];
};

export function emptyNotifyState(): NotifyState {
  return { lastSeenRunId: null, lastFiredAt: {}, quotaLatched: [] };
}

/**
 * Statuses that mean the run is over, one way or another.
 *
 * Keyed off `ScheduledTaskRunStatus` rather than a loose string list so adding a
 * status to the union fails to compile here until someone decides whether it is
 * terminal. Runtime input arrives over HTTP as an unvalidated string, so the
 * lookup stays a plain property check: an unrecognised status is treated as
 * still-running, i.e. we wait rather than declaring an outcome we do not
 * understand.
 */
const TERMINAL: Record<Exclude<ScheduledTaskRunStatus, "running">, true> = {
  success: true,
  partial: true,
  failed: true,
  skipped: true,
};

function isTerminal(status: string): boolean {
  return Object.prototype.hasOwnProperty.call(TERMINAL, status);
}

/** Drop cooldown entries that can no longer suppress anything. */
function pruneCooldowns(lastFiredAt: Record<string, string>, now: Date): Record<string, string> {
  const cutoff = now.getTime() - FAILURE_COOLDOWN_MS;
  const kept: Record<string, string> = {};
  for (const [key, iso] of Object.entries(lastFiredAt)) {
    const at = Date.parse(iso);
    if (Number.isFinite(at) && at >= cutoff) kept[key] = iso;
  }
  return kept;
}

export function decideRunNotifications(args: {
  runs: RunRow[];
  state: NotifyState;
  now: Date;
}): { notifications: ShellNotification[]; state: NotifyState } {
  const { runs, state, now } = args;
  if (runs.length === 0) {
    // An empty table still counts as "I have seen everything there is". Without
    // this the baseline is never set, and the first runs that ever happen get
    // swallowed as history — which is precisely what a fresh install looks like.
    return state.lastSeenRunId === null
      ? { notifications: [], state: { ...state, lastSeenRunId: 0 } }
      : { notifications: [], state };
  }

  const maxId = Math.max(...runs.map((r) => r.id));
  const minId = Math.min(...runs.map((r) => r.id));

  // First ever poll: remember where we are, say nothing.
  if (state.lastSeenRunId === null) {
    return { notifications: [], state: { ...state, lastSeenRunId: maxId } };
  }

  // Overflow: the page does not reach back to what we last saw, so runs happened
  // that we never observed. Alerting for the visible subset would be arbitrary —
  // re-baseline quietly instead.
  if (minId > state.lastSeenRunId + 1) {
    return { notifications: [], state: { ...state, lastSeenRunId: maxId } };
  }

  const fresh = runs
    .filter((r) => r.id > (state.lastSeenRunId ?? 0))
    .sort((a, b) => a.id - b.id);

  const notifications: ShellNotification[] = [];
  let lastFiredAt = pruneCooldowns(state.lastFiredAt, now);
  // Only advance past runs that have actually finished: a `running` row we skip
  // today must still be reportable when it lands.
  let highestSettled = state.lastSeenRunId;

  for (const r of fresh) {
    if (!isTerminal(r.status)) break;
    highestSettled = r.id;

    if (r.status === "failed") {
      // Checked before the manual branch so a manual run that failed reports the
      // failure rather than a cheerful "done".
      const key = `failed:${r.taskKey}`;
      const previous = lastFiredAt[key];
      const suppressed =
        previous !== undefined && now.getTime() - Date.parse(previous) < FAILURE_COOLDOWN_MS;
      if (!suppressed) {
        notifications.push({
          kind: "task-failed",
          title: `任务失败：${r.taskKey}`,
          body: r.errorSummary ?? "没有错误详情，去 /scheduler 看这次运行。",
        });
        lastFiredAt = { ...lastFiredAt, [key]: now.toISOString() };
      }
      continue;
    }

    if (r.trigger === "manual") {
      // No cooldown: you clicked it, you get an answer. Every time.
      notifications.push({
        kind: "manual-done",
        title: `手动任务完成：${r.taskKey}`,
        body: r.status === "partial" ? "完成，但有部分未处理。" : "完成。",
      });
    }
  }

  return {
    notifications,
    state: { ...state, lastSeenRunId: highestSettled, lastFiredAt },
  };
}

export function decideQuotaNotifications(args: {
  items: QuotaItem[];
  state: NotifyState;
  now: Date;
}): { notifications: ShellNotification[]; state: NotifyState } {
  const { items, state } = args;
  const latched = new Set(state.quotaLatched);
  const notifications: ShellNotification[] = [];

  for (const item of items) {
    // provider_usage genuinely carries rows like codex/plan with a null
    // percentage. Coercing null to 0 would alert forever.
    if (item.remainingPercent === null) continue;
    const key = `${item.provider}:${item.itemKey}`;

    if (item.remainingPercent <= QUOTA_LOW_PERCENT) {
      if (!latched.has(key)) {
        latched.add(key);
        notifications.push({
          kind: "quota-low",
          title: `额度快用完了：${item.provider}`,
          body: `${item.label} 剩余 ${item.remainingPercent}%。`,
        });
      }
      continue;
    }

    // Re-arm only once it has genuinely recovered, not the moment it ticks back
    // over the alert line.
    if (item.remainingPercent >= QUOTA_CLEAR_PERCENT) latched.delete(key);
  }

  return { notifications, state: { ...state, quotaLatched: [...latched] } };
}
