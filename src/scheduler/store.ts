import type Database from "better-sqlite3";
import type {
  ScheduledTaskDefinition,
  ScheduledTaskRow,
  ScheduledTaskRunResult,
  ScheduledTaskRunRow,
  ScheduledTaskRunStatus,
  ScheduledTaskRunView,
  ScheduledTaskTrigger,
  ScheduledTaskView,
} from "./types.js";

export type UpdateScheduledTaskPatch = {
  enabled?: boolean;
  intervalSeconds?: number | null;
  nextRunAt?: string | null;
  config?: Record<string, unknown>;
};

export function ensureRegisteredTasks(
  db: Database.Database,
  definitions: ScheduledTaskDefinition[],
  now = new Date()
): void {
  const nowIso = now.toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO scheduled_tasks (
      task_key, enabled, interval_seconds, next_run_at, config_json, created_at, updated_at
    ) VALUES (?, 0, ?, NULL, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const def of definitions) {
      insert.run(
        def.key,
        def.defaultIntervalSeconds,
        JSON.stringify(def.defaultConfig ?? {}),
        nowIso,
        nowIso
      );
    }
  });
  tx();
}

export function listScheduledTasks(
  db: Database.Database,
  definitions: ScheduledTaskDefinition[]
): ScheduledTaskView[] {
  const rows = db
    .prepare(
      `SELECT task_key, enabled, interval_seconds, next_run_at, last_run_id,
              lease_owner, lease_until, config_json, created_at, updated_at
       FROM scheduled_tasks
       ORDER BY task_key`
    )
    .all() as ScheduledTaskRow[];
  const rowsByKey = new Map(rows.map((row) => [row.task_key, row]));
  return definitions.map((def) => {
    const row = rowsByKey.get(def.key);
    if (!row) {
      return {
        key: def.key,
        label: def.label,
        description: def.description,
        category: def.category,
        defaultIntervalSeconds: def.defaultIntervalSeconds,
        sensitivity: def.sensitivity,
        enabled: false,
        intervalSeconds: def.defaultIntervalSeconds,
        nextRunAt: null,
        leaseOwner: null,
        leaseUntil: null,
        config: def.defaultConfig ?? {},
        lastRun: null,
        updatedAt: "",
      };
    }
    return taskRowToView(db, row, def);
  });
}

export function getScheduledTaskRow(
  db: Database.Database,
  taskKey: string
): ScheduledTaskRow | null {
  return (
    (db
      .prepare(
        `SELECT task_key, enabled, interval_seconds, next_run_at, last_run_id,
                lease_owner, lease_until, config_json, created_at, updated_at
         FROM scheduled_tasks
         WHERE task_key = ?`
      )
      .get(taskKey) as ScheduledTaskRow | undefined) ?? null
  );
}

export function updateScheduledTask(
  db: Database.Database,
  taskKey: string,
  patch: UpdateScheduledTaskPatch,
  now = new Date()
): ScheduledTaskRow | null {
  const existing = getScheduledTaskRow(db, taskKey);
  if (!existing) return null;
  const nextEnabled =
    patch.enabled == null ? existing.enabled : patch.enabled ? 1 : 0;
  const nextInterval =
    patch.intervalSeconds === undefined
      ? existing.interval_seconds
      : patch.intervalSeconds;
  const nextConfig =
    patch.config === undefined
      ? existing.config_json
      : JSON.stringify(patch.config);
  const nextRunAt =
    patch.nextRunAt !== undefined
      ? patch.nextRunAt
      : nextEnabled && !existing.enabled
        ? now.toISOString()
        : existing.next_run_at;
  db.prepare(
    `UPDATE scheduled_tasks
     SET enabled = ?,
         interval_seconds = ?,
         next_run_at = ?,
         config_json = ?,
         updated_at = ?
     WHERE task_key = ?`
  ).run(
    nextEnabled,
    nextInterval,
    nextRunAt,
    nextConfig,
    now.toISOString(),
    taskKey
  );
  return getScheduledTaskRow(db, taskKey);
}

export function listDueScheduledTaskKeys(
  db: Database.Database,
  now = new Date(),
  limit = 10
): string[] {
  const rows = db
    .prepare(
      `SELECT task_key
       FROM scheduled_tasks
       WHERE enabled = 1
         AND interval_seconds IS NOT NULL
         AND (next_run_at IS NULL OR next_run_at <= ?)
       ORDER BY COALESCE(next_run_at, ''), task_key
       LIMIT ?`
    )
    .all(now.toISOString(), limit) as Array<{ task_key: string }>;
  return rows.map((row) => row.task_key);
}

export function acquireTaskLease(
  db: Database.Database,
  taskKey: string,
  owner: string,
  leaseUntil: Date,
  now = new Date()
): boolean {
  const info = db
    .prepare(
      `UPDATE scheduled_tasks
       SET lease_owner = ?,
           lease_until = ?,
           updated_at = ?
       WHERE task_key = ?
         AND (lease_until IS NULL OR lease_until <= ? OR lease_owner = ?)`
    )
    .run(
      owner,
      leaseUntil.toISOString(),
      now.toISOString(),
      taskKey,
      now.toISOString(),
      owner
    );
  return info.changes > 0;
}

export function releaseTaskLease(
  db: Database.Database,
  taskKey: string,
  owner: string,
  now = new Date()
): void {
  db.prepare(
    `UPDATE scheduled_tasks
     SET lease_owner = NULL,
         lease_until = NULL,
         updated_at = ?
     WHERE task_key = ? AND lease_owner = ?`
  ).run(now.toISOString(), taskKey, owner);
}

export function startScheduledTaskRun(
  db: Database.Database,
  input: {
    taskKey: string;
    trigger: ScheduledTaskTrigger;
    leaseOwner: string;
    now?: Date;
  }
): number {
  const nowIso = (input.now ?? new Date()).toISOString();
  const info = db
    .prepare(
      `INSERT INTO scheduled_task_runs (
        task_key, trigger, started_at, status, summary_json, lease_owner
      ) VALUES (?, ?, ?, 'running', '{}', ?)`
    )
    .run(input.taskKey, input.trigger, nowIso, input.leaseOwner);
  return Number(info.lastInsertRowid);
}

export function finishScheduledTaskRun(
  db: Database.Database,
  input: {
    runId: number;
    taskKey: string;
    result: ScheduledTaskRunResult;
    nextRunAt?: string | null;
    now?: Date;
  }
): ScheduledTaskRunView {
  const nowIso = (input.now ?? new Date()).toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE scheduled_task_runs
       SET finished_at = ?,
           status = ?,
           summary_json = ?,
           error_summary = ?
       WHERE id = ?`
    ).run(
      nowIso,
      input.result.status,
      JSON.stringify(input.result.summary ?? {}),
      input.result.errorSummary ?? null,
      input.runId
    );
    db.prepare(
      `UPDATE scheduled_tasks
       SET last_run_id = ?,
           next_run_at = ?,
           updated_at = ?
       WHERE task_key = ?`
    ).run(input.runId, input.nextRunAt ?? null, nowIso, input.taskKey);
  });
  tx();
  const row = getScheduledTaskRun(db, input.runId);
  if (!row) throw new Error(`scheduled task run missing after finish: ${input.runId}`);
  return runRowToView(row);
}

export function getScheduledTaskRun(
  db: Database.Database,
  id: number
): ScheduledTaskRunRow | null {
  return (
    (db
      .prepare(
        `SELECT id, task_key, trigger, started_at, finished_at, status,
                summary_json, error_summary, lease_owner
         FROM scheduled_task_runs
         WHERE id = ?`
      )
      .get(id) as ScheduledTaskRunRow | undefined) ?? null
  );
}

export function listScheduledTaskRuns(
  db: Database.Database,
  opts: { taskKey?: string; limit?: number } = {}
): ScheduledTaskRunView[] {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const rows = opts.taskKey
    ? (db
        .prepare(
          `SELECT id, task_key, trigger, started_at, finished_at, status,
                  summary_json, error_summary, lease_owner
           FROM scheduled_task_runs
           WHERE task_key = ?
           ORDER BY started_at DESC, id DESC
           LIMIT ?`
        )
        .all(opts.taskKey, limit) as ScheduledTaskRunRow[])
    : (db
        .prepare(
          `SELECT id, task_key, trigger, started_at, finished_at, status,
                  summary_json, error_summary, lease_owner
           FROM scheduled_task_runs
           ORDER BY started_at DESC, id DESC
           LIMIT ?`
        )
        .all(limit) as ScheduledTaskRunRow[]);
  return rows.map(runRowToView);
}

function taskRowToView(
  db: Database.Database,
  row: ScheduledTaskRow,
  def: ScheduledTaskDefinition
): ScheduledTaskView {
  return {
    key: def.key,
    label: def.label,
    description: def.description,
    category: def.category,
    defaultIntervalSeconds: def.defaultIntervalSeconds,
    sensitivity: def.sensitivity,
    enabled: row.enabled === 1,
    intervalSeconds: row.interval_seconds,
    nextRunAt: row.next_run_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    config: safeJsonObject(row.config_json),
    lastRun: row.last_run_id ? latestRunForTask(db, row.task_key) : null,
    updatedAt: row.updated_at,
  };
}

function latestRunForTask(
  db: Database.Database,
  taskKey: string
): ScheduledTaskRunView | null {
  const row = db
    .prepare(
      `SELECT id, task_key, trigger, started_at, finished_at, status,
              summary_json, error_summary, lease_owner
       FROM scheduled_task_runs
       WHERE task_key = ?
       ORDER BY started_at DESC, id DESC
       LIMIT 1`
    )
    .get(taskKey) as ScheduledTaskRunRow | undefined;
  return row ? runRowToView(row) : null;
}

export function runRowToView(row: ScheduledTaskRunRow): ScheduledTaskRunView {
  return {
    id: row.id,
    taskKey: row.task_key,
    trigger: row.trigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    summary: safeJsonObject(row.summary_json),
    errorSummary: row.error_summary,
    leaseOwner: row.lease_owner,
  };
}

export function isFinishedRunStatus(
  status: ScheduledTaskRunStatus
): status is Exclude<ScheduledTaskRunStatus, "running"> {
  return status !== "running";
}

function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore corrupt historical JSON */
  }
  return {};
}
