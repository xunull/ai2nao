import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { runServe, ServeListenError } from "../src/serve/runServe.js";
import { listDaemonMeta } from "../src/serve/daemonMeta.js";
import { API_VERSION } from "../src/serve/health.js";
import { SCHEMA_VERSION } from "../src/store/migrations.js";

/**
 * Startup ordering, and what happens when the port is already taken.
 *
 * The bug this suite locks out: `runServe` used to call `schedulerLoop.start()`
 * BEFORE `serve()`. `SchedulerLoop.start()` fires `void this.tick()` immediately,
 * so on a port conflict the daemon would run a full round of scheduled tasks and
 * only then die on an uncaught EADDRINUSE. Add the daemon record on top and it
 * gets worse: a note claiming "I am listening on 8787" left behind by a process
 * that never listened at all, which a client would then try to attach to.
 *
 * The order has to be: bind the port → publish the record → start doing work.
 * Anything that fails on the way rolls back what came before it.
 */

const REAL_RUN_DIR = process.env.AI2NAO_RUN_DIR;

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-runserve-"));
  return openDatabase(join(dir, "test.db"));
}

/** Occupy a port so the next bind fails, the way a stray daemon would. */
function occupy(port: number): Promise<Server> {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolvePort(s));
  });
}

/** An ephemeral port that is free right now. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      s.close(() => resolvePort(port));
    });
  });
}

beforeEach(() => {
  process.env.AI2NAO_RUN_DIR = mkdtempSync(join(tmpdir(), "ai2nao-run-"));
});

afterEach(() => {
  if (REAL_RUN_DIR === undefined) delete process.env.AI2NAO_RUN_DIR;
  else process.env.AI2NAO_RUN_DIR = REAL_RUN_DIR;
});

describe("runServe — happy path", () => {
  it("resolves only once the port is actually bound, and publishes a record", async () => {
    const db = freshDb();
    const port = await freePort();
    const handle = await runServe({ db, host: "127.0.0.1", port, withStatic: false });
    try {
      // Resolving means listening: the health endpoint must answer right now, with
      // no retry loop in the test.
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.port).toBe(port);
      expect(body.apiVersion).toBe(API_VERSION);
      expect(body.schemaVersion).toBe(SCHEMA_VERSION);

      const records = listDaemonMeta();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        host: "127.0.0.1",
        port,
        pid: process.pid,
        apiVersion: API_VERSION,
        schemaVersion: SCHEMA_VERSION,
        dbPath: db.name,
      });
    } finally {
      await handle.close();
    }
  });

  it("close() withdraws the record — a stopped daemon must not advertise itself", async () => {
    const db = freshDb();
    const port = await freePort();
    const handle = await runServe({ db, host: "127.0.0.1", port, withStatic: false });
    expect(listDaemonMeta()).toHaveLength(1);
    await handle.close();
    expect(listDaemonMeta()).toEqual([]);
  });
});

describe("runServe — the port is already taken", () => {
  it("rejects with a structured error instead of an uncaught exception", async () => {
    const db = freshDb();
    const port = await freePort();
    const squatter = await occupy(port);
    try {
      await expect(
        runServe({ db, host: "127.0.0.1", port, withStatic: false })
      ).rejects.toBeInstanceOf(ServeListenError);

      // Again, this time inspecting the fields a caller renders.
      const err = await runServe({ db, host: "127.0.0.1", port, withStatic: false }).catch(
        (e: unknown) => e as ServeListenError
      );
      expect(err.code).toBe("EADDRINUSE");
      expect(err.port).toBe(port);
      expect(err.host).toBe("127.0.0.1");
      // ownerPid is best-effort (lsof may be absent); when we get it, it must be
      // this test process, since that is who is holding the port.
      if (err.ownerPid !== null) expect(err.ownerPid).toBe(process.pid);
    } finally {
      squatter.close();
    }
  });

  it("leaves no daemon record behind — nothing may claim a port it never bound", async () => {
    const db = freshDb();
    const port = await freePort();
    const squatter = await occupy(port);
    try {
      await runServe({ db, host: "127.0.0.1", port, withStatic: false }).catch(() => undefined);
      expect(listDaemonMeta()).toEqual([]);
    } finally {
      squatter.close();
    }
  });

  it("does NOT run scheduled tasks — the regression that motivated this file", async () => {
    const db = freshDb();
    const port = await freePort();
    const squatter = await occupy(port);
    try {
      // Make a task due right now. Under the old ordering, start() → tick() would
      // pick this up and write a run row before the process died on EADDRINUSE.
      // lmstudio.models.sync is the cheapest safe choice: it probes a local port
      // that is not listening and fails fast.
      db.prepare(
        `INSERT INTO scheduled_tasks
           (task_key, enabled, interval_seconds, next_run_at, created_at, updated_at)
         VALUES
           ('lmstudio.models.sync', 1, 60, '2000-01-01T00:00:00.000Z',
            '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')
         ON CONFLICT(task_key) DO UPDATE SET
           enabled = 1, interval_seconds = 60, next_run_at = '2000-01-01T00:00:00.000Z'`
      ).run();

      // Sanity: the row really is due, so a scheduler tick WOULD pick it up.
      // Without this the assertion below could pass for the wrong reason.
      const due = db
        .prepare(
          `SELECT COUNT(*) AS c FROM scheduled_tasks
           WHERE enabled = 1 AND interval_seconds IS NOT NULL
             AND (next_run_at IS NULL OR next_run_at <= ?)`
        )
        .get(new Date().toISOString()) as { c: number };
      expect(due.c).toBe(1);

      await runServe({ db, host: "127.0.0.1", port, withStatic: false }).catch(() => undefined);

      const runs = db
        .prepare("SELECT COUNT(*) AS c FROM scheduled_task_runs")
        .get() as { c: number };
      expect(runs.c).toBe(0);
    } finally {
      squatter.close();
    }
  });
});
