import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScheduledTaskRegistry } from "../src/scheduler/registry.js";
import { SchedulerRuntime } from "../src/scheduler/runner.js";
import { getScheduledTaskRow, listScheduledTaskRuns, updateScheduledTask } from "../src/scheduler/store.js";
import type { ScheduledTaskDefinition } from "../src/scheduler/types.js";
import { openDatabase } from "../src/store/open.js";

function openTempDb() {
  const base = join(tmpdir(), `ai2nao-scheduler-runner-${Date.now()}-${Math.random()}`);
  mkdirSync(base, { recursive: true });
  return openDatabase(join(base, "idx.db"));
}

describe("scheduler runner", () => {
  it("runs a task, writes run history, and schedules the next interval", async () => {
    const db = openTempDb();
    try {
      const defs: ScheduledTaskDefinition[] = [
        {
          key: "fake.success",
          label: "Fake success",
          description: "Fake task",
          category: "local_inventory",
          defaultIntervalSeconds: 60,
          sensitivity: "low",
          run: async () => ({ status: "success", summary: { inserted: 1 } }),
        },
      ];
      const runtime = new SchedulerRuntime({
        db,
        registry: new ScheduledTaskRegistry(defs),
        ownerId: "test-runner",
      });
      updateScheduledTask(db, "fake.success", { enabled: true, intervalSeconds: 60 });

      const result = await runtime.runNow("fake.success", "manual");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.run.status).toBe("success");
      expect(result.run.summary.inserted).toBe(1);

      const task = getScheduledTaskRow(db, "fake.success");
      expect(task?.last_run_id).toBe(result.run.id);
      expect(task?.next_run_at).toBeTruthy();
      expect(task?.lease_owner).toBeNull();

      const runs = listScheduledTaskRuns(db, { taskKey: "fake.success" });
      expect(runs).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("records thrown task errors as failed runs", async () => {
    const db = openTempDb();
    try {
      const defs: ScheduledTaskDefinition[] = [
        {
          key: "fake.fail",
          label: "Fake fail",
          description: "Fake task",
          category: "local_inventory",
          defaultIntervalSeconds: 60,
          sensitivity: "low",
          run: async () => {
            throw new Error("boom");
          },
        },
      ];
      const runtime = new SchedulerRuntime({
        db,
        registry: new ScheduledTaskRegistry(defs),
        ownerId: "test-runner",
      });

      const result = await runtime.runNow("fake.fail", "manual");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.run.status).toBe("failed");
      expect(result.run.errorSummary).toBe("boom");
    } finally {
      db.close();
    }
  });
});
