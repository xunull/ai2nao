import {
  decideQuotaNotifications,
  decideRunNotifications,
  RUN_PAGE_SIZE,
  type NotifyState,
  type QuotaItem,
  type RunRow,
  type ShellNotification,
} from "./notifyRules.js";

/**
 * Reads the daemon over HTTP and feeds the notification rules.
 *
 * ## Why two cadences
 *
 * `GET /api/providers` calls `ensureProviderConfigs` (src/providers/store.ts:88-97),
 * an `INSERT OR IGNORE` transaction — so every request takes a write lock, even
 * when it changes nothing. Polling that every 30 seconds turns the shell into a
 * permanent writer against a 898MB database, competing with real syncs, for
 * numbers whose underlying windows are 5 hours and 7 days. Runs are a pure read
 * and genuinely time-sensitive, so they get the fast lane.
 *
 * ## Why the daemon is not modified
 *
 * `/api/scheduler/runs` has no `sinceId` — only `taskKey` and `limit`
 * (src/scheduler/routes.ts:45). Adding one would be a daemon change, and this
 * whole layer is meant to be shell-only. Instead we take one page and let the
 * rules detect the overflow case, where the page no longer reaches back to what
 * we last saw. That trades a guarantee for a boundary: after a long sleep we
 * silently re-baseline rather than replaying or half-replaying the gap.
 */

/** Fast lane: a pure read, and the thing you actually want to hear about promptly. */
export const RUN_POLL_MS = 30_000;

/** Slow lane: takes a write lock, and the underlying windows are hours to days. */
export const QUOTA_POLL_MS = 5 * 60_000;

export type PollClock = {
  lastRunPollAt: number | null;
  lastQuotaPollAt: number | null;
};

export function emptyPollClock(): PollClock {
  return { lastRunPollAt: null, lastQuotaPollAt: null };
}

export type PollSchedule = { pollRuns: boolean; pollQuota: boolean };

/** Which lanes are due. Never polled yet counts as due. */
export function decidePoll(args: { now: number; clock: PollClock }): PollSchedule {
  const { now, clock } = args;
  return {
    pollRuns: clock.lastRunPollAt === null || now - clock.lastRunPollAt >= RUN_POLL_MS,
    pollQuota: clock.lastQuotaPollAt === null || now - clock.lastQuotaPollAt >= QUOTA_POLL_MS,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * `{ runs: ScheduledTaskRunView[] }` → `RunRow[]`, dropping anything malformed.
 *
 * Dropping rather than coercing is deliberate. A row with an `undefined` status
 * never looks terminal, so it would stall the cursor and quietly switch off every
 * notification — the kind of failure nobody notices for weeks.
 */
export function mapRunRows(payload: unknown): RunRow[] {
  if (!isRecord(payload) || !Array.isArray(payload.runs)) return [];
  const out: RunRow[] = [];
  for (const raw of payload.runs) {
    if (!isRecord(raw)) continue;
    const { id, taskKey, trigger, startedAt, status } = raw;
    if (
      typeof id !== "number" ||
      typeof taskKey !== "string" ||
      typeof trigger !== "string" ||
      typeof startedAt !== "string" ||
      typeof status !== "string"
    ) {
      continue;
    }
    out.push({
      id,
      taskKey,
      trigger,
      startedAt,
      status,
      finishedAt: typeof raw.finishedAt === "string" ? raw.finishedAt : null,
      errorSummary: typeof raw.errorSummary === "string" ? raw.errorSummary : null,
    });
  }
  return out;
}

/** `{ providers: ProviderView[] }` → flat quota lines for enabled providers only. */
export function mapQuotaItems(payload: unknown): QuotaItem[] {
  if (!isRecord(payload) || !Array.isArray(payload.providers)) return [];
  const out: QuotaItem[] = [];
  for (const p of payload.providers) {
    if (!isRecord(p) || typeof p.id !== "string") continue;
    // A provider the user switched off should never produce an alert.
    if (p.enabled !== true || !Array.isArray(p.items)) continue;
    for (const item of p.items) {
      if (!isRecord(item) || typeof item.key !== "string") continue;
      out.push({
        provider: p.id,
        itemKey: item.key,
        label: typeof item.label === "string" ? item.label : item.key,
        remainingPercent:
          typeof item.remainingPercent === "number" ? item.remainingPercent : null,
      });
    }
  }
  return out;
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url);
  if (!res.ok) return null;
  return (await res.json()) as unknown;
}

export type PollResult = {
  notifications: ShellNotification[];
  state: NotifyState;
  clock: PollClock;
};

/**
 * One tick. Polls whichever lanes are due, returns the notifications to show and
 * the advanced state.
 *
 * Never throws. A daemon that stopped mid-session is an ordinary event — the
 * shell keeps running and picks up again when it returns. Critically, a failed
 * poll leaves `lastSeenRunId` untouched: dropping it would make the next
 * successful poll look like a first run and replay the gap.
 */
export async function pollOnce(args: {
  baseUrl: string;
  state: NotifyState;
  clock: PollClock;
  now: number;
  fetchImpl?: typeof fetch;
}): Promise<PollResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const schedule = decidePoll({ now: args.now, clock: args.clock });
  const nowDate = new Date(args.now);

  let state = args.state;
  let clock = args.clock;
  const notifications: ShellNotification[] = [];

  if (schedule.pollRuns) {
    try {
      const payload = await getJson(
        fetchImpl,
        `${args.baseUrl}/api/scheduler/runs?limit=${RUN_PAGE_SIZE}`
      );
      const decided = decideRunNotifications({
        runs: mapRunRows(payload),
        state,
        now: nowDate,
      });
      notifications.push(...decided.notifications);
      state = decided.state;
      clock = { ...clock, lastRunPollAt: args.now };
    } catch {
      // Daemon gone or wedged. Leave state alone and try again next tick.
    }
  }

  if (schedule.pollQuota) {
    try {
      const payload = await getJson(fetchImpl, `${args.baseUrl}/api/providers`);
      const decided = decideQuotaNotifications({
        items: mapQuotaItems(payload),
        state,
        now: nowDate,
      });
      notifications.push(...decided.notifications);
      state = decided.state;
      clock = { ...clock, lastQuotaPollAt: args.now };
    } catch {
      /* same */
    }
  }

  return { notifications, state, clock };
}
