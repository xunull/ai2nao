import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { registerWorkCosmosRoutes } from "../src/workCosmos/routes.js";
import { SchedulerRuntime } from "../src/scheduler/runner.js";
import { ScheduledTaskRegistry } from "../src/scheduler/registry.js";
import type { ScheduledTaskDefinition } from "../src/scheduler/types.js";
import {
  resetCosmosProgress,
  startCosmosProgress,
  updateCosmosProgress,
  finishCosmosProgress,
} from "../src/workCosmos/progress.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-cosmos-routes-"));
  return openDatabase(join(dir, "test.db"));
}

function makeScheduler(
  db: Database.Database,
  runImpl: () => Promise<{ status: "success" | "partial" | "failed" }>
): SchedulerRuntime {
  const def: ScheduledTaskDefinition = {
    key: "work.cosmos.refresh",
    label: "test",
    description: "test",
    category: "derived",
    defaultIntervalSeconds: 3600,
    sensitivity: "high",
    run: async () => {
      const r = await runImpl();
      return { status: r.status, summary: {}, errorSummary: null };
    },
  };
  const registry = new ScheduledTaskRegistry([def]);
  return new SchedulerRuntime({ db, registry });
}

describe("Cosmos routes", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
    resetCosmosProgress();
  });

  it("GET /api/work-cosmos/points returns empty payload on fresh DB", async () => {
    const app = new Hono();
    registerWorkCosmosRoutes(app, db, undefined);
    const res = await app.request("http://x/api/work-cosmos/points");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      points: unknown[];
      pointCount: number;
      projectionMethod: string;
    };
    expect(body.ok).toBe(true);
    expect(body.points).toEqual([]);
    expect(body.pointCount).toBe(0);
    expect(body.projectionMethod).toBe("none");
  });

  it("GET /api/work-cosmos/refresh-status starts idle", async () => {
    const app = new Hono();
    registerWorkCosmosRoutes(app, db, undefined);
    const res = await app.request("http://x/api/work-cosmos/refresh-status");
    const body = (await res.json()) as { phase: string; totalCount: number };
    expect(body.phase).toBe("idle");
    expect(body.totalCount).toBe(0);
  });

  it("refresh-status reflects in-memory progress updates", async () => {
    const app = new Hono();
    registerWorkCosmosRoutes(app, db, undefined);

    startCosmosProgress(10);
    updateCosmosProgress({ phase: "embedding", indexedCount: 5 });
    const mid = await (
      await app.request("http://x/api/work-cosmos/refresh-status")
    ).json() as { phase: string; indexedCount: number };
    expect(mid.phase).toBe("embedding");
    expect(mid.indexedCount).toBe(5);

    finishCosmosProgress({ ok: true });
    const end = await (
      await app.request("http://x/api/work-cosmos/refresh-status")
    ).json() as { phase: string };
    expect(end.phase).toBe("done");
  });

  it("POST refresh returns 503 when scheduler is undefined", async () => {
    const app = new Hono();
    registerWorkCosmosRoutes(app, db, undefined);
    const res = await app.request("http://x/api/work-cosmos/refresh", {
      method: "POST",
    });
    expect(res.status).toBe(503);
  });

  it("POST refresh runs task via scheduler and returns the run record", async () => {
    let runCount = 0;
    const scheduler = makeScheduler(db, async () => {
      runCount++;
      return { status: "success" };
    });
    const app = new Hono();
    registerWorkCosmosRoutes(app, db, scheduler);

    const res = await app.request("http://x/api/work-cosmos/refresh", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(runCount).toBe(1);
  });

  it("POST refresh returns 409 when task is already running (D4 lease)", async () => {
    let resolveRunning: (() => void) | null = null;
    const blocked = new Promise<void>((res) => {
      resolveRunning = res;
    });
    const scheduler = makeScheduler(db, async () => {
      await blocked;
      return { status: "success" };
    });
    const app = new Hono();
    registerWorkCosmosRoutes(app, db, scheduler);

    const firstPromise = app.request("http://x/api/work-cosmos/refresh", {
      method: "POST",
    });
    // give the first request a tick to acquire the lease
    await new Promise((r) => setTimeout(r, 50));

    const second = await app.request("http://x/api/work-cosmos/refresh", {
      method: "POST",
    });
    expect(second.status).toBe(409);

    resolveRunning?.();
    await firstPromise; // unblock
  });
});
