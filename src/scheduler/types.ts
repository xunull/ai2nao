import type Database from "better-sqlite3";

export type ScheduledTaskCategory =
  | "local_inventory"
  | "browser"
  | "editor"
  | "model_cache"
  | "derived";

export type ScheduledTaskSensitivity = "low" | "medium" | "high";

export type ScheduledTaskTrigger = "manual" | "scheduled" | "cli";

export type ScheduledTaskRunStatus =
  | "running"
  | "success"
  | "partial"
  | "failed"
  | "skipped";

export type ScheduledTaskContext = {
  db: Database.Database;
  config: Record<string, unknown>;
  atuin?: { db: Database.Database; path: string };
};

export type ScheduledTaskRunResult = {
  status: Exclude<ScheduledTaskRunStatus, "running">;
  summary?: Record<string, unknown>;
  errorSummary?: string | null;
};

export type ScheduledTaskDefinition = {
  key: string;
  label: string;
  description: string;
  category: ScheduledTaskCategory;
  defaultIntervalSeconds: number;
  sensitivity: ScheduledTaskSensitivity;
  defaultConfig?: Record<string, unknown>;
  run(ctx: ScheduledTaskContext): Promise<ScheduledTaskRunResult>;
};

export type ScheduledTaskRow = {
  task_key: string;
  enabled: number;
  interval_seconds: number | null;
  next_run_at: string | null;
  last_run_id: number | null;
  lease_owner: string | null;
  lease_until: string | null;
  config_json: string;
  created_at: string;
  updated_at: string;
};

export type ScheduledTaskRunRow = {
  id: number;
  task_key: string;
  trigger: ScheduledTaskTrigger;
  started_at: string;
  finished_at: string | null;
  status: ScheduledTaskRunStatus;
  summary_json: string;
  error_summary: string | null;
  lease_owner: string | null;
};

export type ScheduledTaskView = {
  key: string;
  label: string;
  description: string;
  category: ScheduledTaskCategory;
  defaultIntervalSeconds: number;
  sensitivity: ScheduledTaskSensitivity;
  enabled: boolean;
  intervalSeconds: number | null;
  nextRunAt: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  config: Record<string, unknown>;
  lastRun: ScheduledTaskRunView | null;
  updatedAt: string;
};

export type ScheduledTaskRunView = {
  id: number;
  taskKey: string;
  trigger: ScheduledTaskTrigger;
  startedAt: string;
  finishedAt: string | null;
  status: ScheduledTaskRunStatus;
  summary: Record<string, unknown>;
  errorSummary: string | null;
  leaseOwner: string | null;
};

export type SchedulerRunNowResult =
  | { ok: true; run: ScheduledTaskRunView }
  | { ok: false; status: "unknown_task" | "locked"; message: string };
