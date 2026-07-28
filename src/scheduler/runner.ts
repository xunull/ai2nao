import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ScheduledTaskRegistry } from "./registry.js";
import {
  acquireTaskLease,
  ensureRegisteredTasks,
  finishScheduledTaskRun,
  getScheduledTaskRow,
  listDueScheduledTaskKeys,
  releaseTaskLease,
  startScheduledTaskRun,
} from "./store.js";
import type {
  ScheduledTaskContext,
  ScheduledTaskRunResult,
  ScheduledTaskTrigger,
  SchedulerRunNowResult,
} from "./types.js";

export type SchedulerRuntimeOptions = {
  db: Database.Database;
  registry: ScheduledTaskRegistry;
  atuin?: { db: Database.Database; path: string };
  ownerId?: string;
  leaseMs?: number;
};

export class SchedulerRuntime {
  readonly db: Database.Database;
  readonly registry: ScheduledTaskRegistry;
  readonly ownerId: string;
  readonly leaseMs: number;
  readonly atuin?: { db: Database.Database; path: string };
  private readonly runningTaskKeys = new Set<string>();

  constructor(opts: SchedulerRuntimeOptions) {
    this.db = opts.db;
    this.registry = opts.registry;
    this.atuin = opts.atuin;
    this.ownerId = opts.ownerId ?? `scheduler-${randomUUID()}`;
    this.leaseMs = opts.leaseMs ?? 10 * 60 * 1000;
    ensureRegisteredTasks(this.db, this.registry.list());
  }

  async runNow(
    taskKey: string,
    trigger: ScheduledTaskTrigger
  ): Promise<SchedulerRunNowResult> {
    const definition = this.registry.get(taskKey);
    if (!definition) {
      return { ok: false, status: "unknown_task", message: `unknown task: ${taskKey}` };
    }
    if (this.runningTaskKeys.has(taskKey)) {
      return { ok: false, status: "locked", message: `task already running: ${taskKey}` };
    }

    const now = new Date();
    // per-task lease 优先:遍历全部仓库那类任务可能跑好几分钟,10 分钟全局默认不够。
    const leaseUntil = new Date(
      now.getTime() + (definition.leaseMs ?? this.leaseMs)
    );
    const acquired = acquireTaskLease(
      this.db,
      taskKey,
      this.ownerId,
      leaseUntil,
      now
    );
    if (!acquired) {
      return { ok: false, status: "locked", message: `task lease is held: ${taskKey}` };
    }

    this.runningTaskKeys.add(taskKey);
    const runId = startScheduledTaskRun(this.db, {
      taskKey,
      trigger,
      leaseOwner: this.ownerId,
      now,
    });

    let result: ScheduledTaskRunResult;
    try {
      const taskRow = getScheduledTaskRow(this.db, taskKey);
      const ctx: ScheduledTaskContext = {
        db: this.db,
        config: safeJsonObject(taskRow?.config_json ?? "{}"),
        atuin: this.atuin,
      };
      result = await definition.run(ctx);
    } catch (e) {
      result = {
        status: "failed",
        summary: {},
        errorSummary: e instanceof Error ? e.message : String(e),
      };
    }

    try {
      const finishedAt = new Date();
      const taskRow = getScheduledTaskRow(this.db, taskKey);
      const nextRunAt = nextRunAtFor(taskRow?.enabled === 1, taskRow?.interval_seconds, finishedAt);
      const run = finishScheduledTaskRun(this.db, {
        runId,
        taskKey,
        result,
        nextRunAt,
        now: finishedAt,
      });
      return { ok: true, run };
    } finally {
      releaseTaskLease(this.db, taskKey, this.ownerId);
      this.runningTaskKeys.delete(taskKey);
    }
  }

  async tick(limit = 10): Promise<void> {
    const due = listDueScheduledTaskKeys(this.db, new Date(), limit);
    for (const taskKey of due) {
      await this.runNow(taskKey, "scheduled");
    }
  }
}

function nextRunAtFor(
  enabled: boolean,
  intervalSeconds: number | null | undefined,
  from: Date
): string | null {
  if (!enabled || intervalSeconds == null || intervalSeconds <= 0) return null;
  return new Date(from.getTime() + intervalSeconds * 1000).toISOString();
}

function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore corrupt task config */
  }
  return {};
}
