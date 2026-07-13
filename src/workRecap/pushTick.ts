import type Database from "better-sqlite3";
import { readLlmChatConfig } from "../llmChat/config.js";
import { readNotifyConfig, type NotifyConfig } from "../notify/config.js";
import { postFeishuCard, type FetchJson } from "../notify/feishu.js";
import { isSparseFacts } from "./facts.js";
import { clearInflight, isInflight, setInflight } from "./inflight.js";
import { renderFeishuCard, type RecapPushKind } from "./push.js";
import { generateRecap, type GenerateRecapResult } from "./service.js";
import type { WorkRecapRun, WorkRecapWindow } from "./types.js";
import { isoWeekKey, localDayKey } from "./window.js";

/**
 * The scheduled-push tick.
 *
 * ai2nao's scheduler is INTERVAL-only (`next_run_at = finished_at + interval`),
 * so "每周一 09:00" cannot be expressed natively. Instead this task runs on a
 * short interval (10 min) and does its own calendar guard: it computes the
 * period that *should* have been sent by now, and sends it exactly once.
 * Catch-up is free (a late boot just fires on the next tick), which is what the
 * "应用常开,漏了补发" decision asked for.
 *
 * Invariant: **at most one period per kind is ever considered per tick** — this
 * never mass-backfills history.
 */

/** Late-send caps. The point is "开机晚了补发", NOT "补一整周" — a Friday boot
 *  must not push last week's Monday report. (An earlier design used a full
 *  period as the cap, which provably failed that exact goal.) */
export const DAILY_LATE_CAP_MS = 6 * 3_600_000;
export const WEEKLY_LATE_CAP_MS = 24 * 3_600_000;
export const MAX_PUSH_ATTEMPTS = 3;
/** Shorter than the interactive 60s: a slow LLM here stalls the whole scheduler. */
export const PUSH_LLM_TIMEOUT_MS = 45_000;

export type PushAction =
  | "sent"
  | "failed"
  | "skipped"
  | "not_due"
  | "inflight"
  | "disabled";

export type TickOutcome = {
  kind: RecapPushKind;
  periodKey: string | null;
  action: PushAction;
  reason?: string;
};

type PushRow = {
  kind: string;
  period_key: string;
  status: string;
  attempts: number;
};

const WINDOW_FOR: Record<RecapPushKind, WorkRecapWindow> = {
  daily: "today",
  weekly: "last-week",
};

/** Local midnight of `d`. */
function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * When this kind's report was due, in local time.
 *   daily  → 今天 atHour:00
 *   weekly → 本周的 weekday(1=Mon) atHour:00
 * Stable for every tick within the period, which is what makes the guard idempotent.
 */
export function dueAtFor(kind: RecapPushKind, now: Date, cfg: NotifyConfig): Date {
  if (kind === "daily") {
    const d = startOfLocalDay(now);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), cfg.daily.atHour);
  }
  const day = startOfLocalDay(now);
  const sinceMonday = (day.getDay() + 6) % 7; // 0=Mon
  const monday = new Date(day.getFullYear(), day.getMonth(), day.getDate() - sinceMonday);
  const offset = cfg.weekly.weekday - 1; // 1=Mon → 0
  return new Date(
    monday.getFullYear(),
    monday.getMonth(),
    monday.getDate() + offset,
    cfg.weekly.atHour
  );
}

/**
 * The period this send COVERS (not when it fires).
 *   daily  → 今天           → 2026-07-13
 *   weekly → 上一个自然周   → ISO week key of (dueAt - 7d), e.g. 2026-W28
 * Weekly uses the ISO week-YEAR (2026-12-28 lives in 2027-W01), otherwise the
 * (kind, period_key) primary key would collide across the year boundary.
 */
export function periodKeyFor(kind: RecapPushKind, dueAt: Date): string {
  if (kind === "daily") return localDayKey(dueAt);
  return isoWeekKey(new Date(dueAt.getTime() - 7 * 86_400_000));
}

function getRow(db: Database.Database, kind: string, periodKey: string): PushRow | undefined {
  return db
    .prepare(
      `SELECT kind, period_key, status, attempts FROM recap_push_log
        WHERE kind = ? AND period_key = ?`
    )
    .get(kind, periodKey) as PushRow | undefined;
}

function countRows(db: Database.Database, kind: string): number {
  return (
    db.prepare(`SELECT COUNT(*) c FROM recap_push_log WHERE kind = ?`).get(kind) as {
      c: number;
    }
  ).c;
}

function upsert(
  db: Database.Database,
  v: {
    kind: string;
    periodKey: string;
    dueAt: Date;
    status: string;
    reason?: string | null;
    runId?: number | null;
    sentAt?: string | null;
    latenessMs?: number | null;
    error?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO recap_push_log
       (kind, period_key, due_at, sent_at, run_id, status, reason, attempts, lateness_ms, error, updated_at)
     VALUES (@kind, @period_key, @due_at, @sent_at, @run_id, @status, @reason, 1, @lateness_ms, @error, @updated_at)
     ON CONFLICT(kind, period_key) DO UPDATE SET
       due_at = excluded.due_at,
       sent_at = COALESCE(excluded.sent_at, recap_push_log.sent_at),
       run_id = COALESCE(excluded.run_id, recap_push_log.run_id),
       status = excluded.status,
       reason = excluded.reason,
       attempts = recap_push_log.attempts + 1,
       lateness_ms = excluded.lateness_ms,
       error = excluded.error,
       updated_at = excluded.updated_at`
  ).run({
    kind: v.kind,
    period_key: v.periodKey,
    due_at: v.dueAt.toISOString(),
    sent_at: v.sentAt ?? null,
    run_id: v.runId ?? null,
    status: v.status,
    reason: v.reason ?? null,
    lateness_ms: v.latenessMs ?? null,
    error: v.error ?? null,
    updated_at: new Date().toISOString(),
  });
}

export type RecapPushTickOptions = {
  now?: () => Date;
  /** Override config (tests). Defaults to ~/.ai2nao/notify.json. */
  config?: NotifyConfig | null;
  /** Injectable HTTP (tests). */
  fetchJson?: FetchJson;
  /** Override the generate pipeline (tests). */
  generateImpl?: (
    windowKey: WorkRecapWindow,
    runtime: { db: Database.Database; llmConfig: ReturnType<typeof readLlmChatConfig>; llmTimeoutMs?: number }
  ) => Promise<GenerateRecapResult>;
};

async function tickOne(
  db: Database.Database,
  kind: RecapPushKind,
  cfg: NotifyConfig,
  now: Date,
  opts: RecapPushTickOptions
): Promise<TickOutcome> {
  const enabled = kind === "daily" ? cfg.daily.enabled : cfg.weekly.enabled;
  if (!enabled) return { kind, periodKey: null, action: "disabled" };

  const dueAt = dueAtFor(kind, now, cfg);
  if (now.getTime() < dueAt.getTime()) {
    return { kind, periodKey: null, action: "not_due" };
  }
  const periodKey = periodKeyFor(kind, dueAt);

  const existing = getRow(db, kind, periodKey);
  if (existing?.status === "sent") {
    return { kind, periodKey, action: "skipped", reason: "already_sent" };
  }
  if (existing?.status === "skipped") {
    return { kind, periodKey, action: "skipped", reason: "already_decided" };
  }
  if (existing && existing.attempts >= MAX_PUSH_ATTEMPTS) {
    return { kind, periodKey, action: "skipped", reason: "max_attempts" };
  }

  // First enable: don't retro-push the period that was already half over when
  // the user turned this on. Seed it as skipped and start from the next one.
  if (!existing && countRows(db, kind) === 0) {
    upsert(db, { kind, periodKey, dueAt, status: "skipped", reason: "first_enable" });
    return { kind, periodKey, action: "skipped", reason: "first_enable" };
  }

  const latenessMs = now.getTime() - dueAt.getTime();
  const cap = kind === "daily" ? DAILY_LATE_CAP_MS : WEEKLY_LATE_CAP_MS;
  if (latenessMs > cap) {
    upsert(db, { kind, periodKey, dueAt, status: "skipped", reason: "too_late", latenessMs });
    return { kind, periodKey, action: "skipped", reason: "too_late" };
  }

  const windowKey = WINDOW_FOR[kind];
  // Share the guard with the HTTP route: never double-generate the same window.
  if (isInflight(windowKey)) {
    return { kind, periodKey, action: "inflight" };
  }

  const generate = opts.generateImpl ?? generateRecap;
  const runtime = {
    db,
    llmConfig: readLlmChatConfig(),
    llmTimeoutMs: PUSH_LLM_TIMEOUT_MS,
  };

  let result: GenerateRecapResult;
  let resolveP!: (r: WorkRecapRun) => void;
  let rejectP!: (e: unknown) => void;
  const promise = new Promise<WorkRecapRun>((res, rej) => {
    resolveP = res;
    rejectP = rej;
  });
  promise.catch(() => {}); // no unhandled rejection if nobody awaits
  setInflight(windowKey, { startedAt: now, promise });
  try {
    result = await generate(windowKey, runtime);
    if (result.kind === "ok") resolveP(result.run);
    else rejectP(new Error("empty"));
  } catch (e) {
    rejectP(e);
    upsert(db, {
      kind,
      periodKey,
      dueAt,
      status: "failed",
      reason: "generate_failed",
      latenessMs,
      error: e instanceof Error ? e.message : String(e),
    });
    return { kind, periodKey, action: "failed", reason: "generate_failed" };
  } finally {
    clearInflight(windowKey);
  }

  if (result.kind === "empty") {
    upsert(db, { kind, periodKey, dueAt, status: "skipped", reason: "no_repos", latenessMs });
    return { kind, periodKey, action: "skipped", reason: "no_repos" };
  }

  const run = result.run;
  // Idle day: commits AND tokens AND topics all empty → don't ping the user
  // with a canned "nothing happened" card.
  if (isSparseFacts(run.facts)) {
    upsert(db, {
      kind,
      periodKey,
      dueAt,
      status: "skipped",
      reason: "no_signal",
      runId: run.id,
      latenessMs,
    });
    return { kind, periodKey, action: "skipped", reason: "no_signal" };
  }

  const card = renderFeishuCard(kind, run);
  const posted = await postFeishuCard({
    webhookUrl: cfg.feishu.webhookUrl,
    secret: cfg.feishu.secret,
    card,
    now: () => now,
    fetchJson: opts.fetchJson,
  });

  if (!posted.ok) {
    upsert(db, {
      kind,
      periodKey,
      dueAt,
      status: "failed",
      reason: "post_failed",
      runId: run.id,
      latenessMs,
      error: posted.error,
    });
    return { kind, periodKey, action: "failed", reason: posted.error };
  }

  upsert(db, {
    kind,
    periodKey,
    dueAt,
    status: "sent",
    runId: run.id,
    sentAt: new Date().toISOString(),
    latenessMs,
  });
  return { kind, periodKey, action: "sent" };
}

/** Run the calendar guard for both kinds. Never throws. */
export async function runRecapPushTick(
  db: Database.Database,
  opts: RecapPushTickOptions = {}
): Promise<TickOutcome[]> {
  const cfg = opts.config !== undefined ? opts.config : readNotifyConfig();
  if (!cfg || !cfg.feishu.enabled) {
    // Not configured = feature off. Silent, no error, no log spam.
    return [
      { kind: "daily", periodKey: null, action: "disabled" },
      { kind: "weekly", periodKey: null, action: "disabled" },
    ];
  }
  const now = opts.now ? opts.now() : new Date();
  const out: TickOutcome[] = [];
  for (const kind of ["daily", "weekly"] as RecapPushKind[]) {
    out.push(await tickOne(db, kind, cfg, now, opts));
  }
  return out;
}
