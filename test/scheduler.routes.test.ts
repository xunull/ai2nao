import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { ScheduledTaskRegistry } from "../src/scheduler/registry.js";
import { SchedulerRuntime } from "../src/scheduler/runner.js";
import type { ScheduledTaskDefinition } from "../src/scheduler/types.js";
import { openDatabase } from "../src/store/open.js";

function openTempDb() {
  const base = join(tmpdir(), `ai2nao-scheduler-routes-${Date.now()}-${Math.random()}`);
  mkdirSync(base, { recursive: true });
  return openDatabase(join(base, "idx.db"));
}

describe("scheduler routes", () => {
  it("lists, updates, runs, and returns run history", async () => {
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
          run: async () => ({ status: "success", summary: { ok: true } }),
        },
      ];
      const runtime = new SchedulerRuntime({
        db,
        registry: new ScheduledTaskRegistry(defs),
        ownerId: "routes",
      });
      const app = createApp({ db, schedulerRuntime: runtime });

      const list = await app.request("http://x/api/scheduler/tasks");
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as { tasks: Array<{ key: string; enabled: boolean }> };
      expect(listBody.tasks[0]).toMatchObject({ key: "fake.success", enabled: false });

      const patch = await app.request("http://x/api/scheduler/tasks/fake.success", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, intervalSeconds: 300 }),
      });
      expect(patch.status).toBe(200);
      const patchBody = (await patch.json()) as { task: { enabled: boolean; intervalSeconds: number } };
      expect(patchBody.task.enabled).toBe(true);
      expect(patchBody.task.intervalSeconds).toBe(300);

      const run = await app.request("http://x/api/scheduler/tasks/fake.success/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(run.status).toBe(200);
      const runBody = (await run.json()) as { ok: true; run: { status: string } };
      expect(runBody.run.status).toBe("success");

      const runs = await app.request("http://x/api/scheduler/runs?taskKey=fake.success");
      expect(runs.status).toBe(200);
      const runsBody = (await runs.json()) as { runs: Array<{ taskKey: string }> };
      expect(runsBody.runs[0].taskKey).toBe("fake.success");

      const unknown = await app.request("http://x/api/scheduler/tasks/nope/run", {
        method: "POST",
        body: "{}",
      });
      expect(unknown.status).toBe(404);
    } finally {
      db.close();
    }
  });
});
