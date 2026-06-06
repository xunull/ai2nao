import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/open.js";
import {
  acquireTaskLease,
  ensureRegisteredTasks,
  listScheduledTasks,
  updateScheduledTask,
} from "../src/scheduler/store.js";
import type { ScheduledTaskDefinition } from "../src/scheduler/types.js";

const defs: ScheduledTaskDefinition[] = [
  {
    key: "fake.success",
    label: "Fake success",
    description: "Fake task",
    category: "local_inventory",
    defaultIntervalSeconds: 60,
    sensitivity: "low",
    run: async () => ({ status: "success" }),
  },
];

function openTempDb() {
  const base = join(tmpdir(), `ai2nao-scheduler-store-${Date.now()}-${Math.random()}`);
  mkdirSync(base, { recursive: true });
  return openDatabase(join(base, "idx.db"));
}

describe("scheduler store", () => {
  it("registers tasks disabled and preserves user configuration on re-register", () => {
    const db = openTempDb();
    try {
      ensureRegisteredTasks(db, defs, new Date("2026-06-01T00:00:00.000Z"));
      let tasks = listScheduledTasks(db, defs);
      expect(tasks[0].enabled).toBe(false);
      expect(tasks[0].intervalSeconds).toBe(60);

      updateScheduledTask(db, "fake.success", {
        enabled: true,
        intervalSeconds: 300,
        config: { hello: "world" },
      }, new Date("2026-06-01T01:00:00.000Z"));
      ensureRegisteredTasks(db, defs, new Date("2026-06-01T02:00:00.000Z"));
      tasks = listScheduledTasks(db, defs);
      expect(tasks[0].enabled).toBe(true);
      expect(tasks[0].intervalSeconds).toBe(300);
      expect(tasks[0].config).toEqual({ hello: "world" });
    } finally {
      db.close();
    }
  });

  it("acquires fresh and stale leases but rejects active leases", () => {
    const db = openTempDb();
    try {
      ensureRegisteredTasks(db, defs);
      const now = new Date("2026-06-01T00:00:00.000Z");
      expect(
        acquireTaskLease(
          db,
          "fake.success",
          "owner-a",
          new Date("2026-06-01T00:10:00.000Z"),
          now
        )
      ).toBe(true);
      expect(
        acquireTaskLease(
          db,
          "fake.success",
          "owner-b",
          new Date("2026-06-01T00:11:00.000Z"),
          new Date("2026-06-01T00:01:00.000Z")
        )
      ).toBe(false);
      expect(
        acquireTaskLease(
          db,
          "fake.success",
          "owner-b",
          new Date("2026-06-01T00:30:00.000Z"),
          new Date("2026-06-01T00:11:00.000Z")
        )
      ).toBe(true);
    } finally {
      db.close();
    }
  });
});
