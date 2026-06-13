import { describe, expect, it, beforeEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import {
  __resetInflightForTests,
  registerWorkRecapRoutes,
} from "../src/workRecap/routes.js";
import type { WorkRecapRuntime } from "../src/workRecap/service.js";
import type { WorkRecapWindow } from "../src/workRecap/types.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-recap-routes-"));
  return openDatabase(join(dir, "test.db"));
}

function seedRepo(db: Database.Database, path: string): void {
  db.prepare(
    `INSERT INTO repos (path_canonical, origin_url, first_seen_at, last_scanned_at)
     VALUES (?, ?, ?, ?)`
  ).run(path, null, "2026-06-01T00:00:00Z", null);
}

type RuntimeOverride = Partial<WorkRecapRuntime>;

function buildApp(
  db: Database.Database,
  runtimeOverride: RuntimeOverride = {}
): Hono {
  const app = new Hono();
  registerWorkRecapRoutes(app, db, {
    runtimeFactory: (d) => ({
      db: d,
      llmConfig: null,
      authorEmail: "test@example.com",
      resolveAuthorEmail: () => "test@example.com",
      resolveRepoPaths: (rt) =>
        runtimeOverride.resolveRepoPaths
          ? runtimeOverride.resolveRepoPaths(rt)
          : (rt
              .prepare(`SELECT path_canonical FROM repos`)
              .all() as Array<{ path_canonical: string }>).map(
              (r) => r.path_canonical
            ),
      now: runtimeOverride.now,
      fetchImpl: runtimeOverride.fetchImpl,
    }),
  });
  return app;
}

describe("workRecap routes", () => {
  beforeEach(() => {
    __resetInflightForTests();
  });

  it("400s on invalid window param", async () => {
    const db = freshDb();
    const app = buildApp(db);
    const res = await app.request("http://x/api/work-recap/generate?window=999d", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("F5 T-A2: returns empty payload when repos table is empty", async () => {
    const db = freshDb();
    const app = buildApp(db);
    const res = await app.request("http://x/api/work-recap/generate?window=7d", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; empty: boolean; reason: string };
    expect(body).toEqual({ ok: true, empty: true, reason: "no_repos_indexed" });
    // No row should have been inserted
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM work_recap_runs`)
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("F5 T-A3: returns 409 inflight when same window already running", async () => {
    const db = freshDb();
    seedRepo(db, "/path/a");

    let releaseFirst: () => void = () => {};
    const blocker = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const app = new Hono();
    registerWorkRecapRoutes(app, db, {
      runtimeFactory: (d) => ({
        db: d,
        llmConfig: null,
        authorEmail: "test@example.com",
        resolveAuthorEmail: () => "test@example.com",
        resolveRepoPaths: () => ["/path/a"],
      }),
      generateImpl: async () => {
        // Block until the second request has had time to see in-flight.
        await blocker;
        return {
          kind: "empty",
          response: {
            ok: true,
            empty: true,
            reason: "no_repos_indexed",
          },
        };
      },
    });

    const firstPromise = app.request(
      "http://x/api/work-recap/generate?window=7d",
      { method: "POST" }
    );

    // Yield so routes.ts has time to set the in-flight slot and enter await.
    await new Promise((r) => setImmediate(r));

    const second = await app.request(
      "http://x/api/work-recap/generate?window=7d",
      { method: "POST" }
    );
    expect(second.status).toBe(409);
    const body = (await second.json()) as {
      ok: boolean;
      inflight: boolean;
      windowKey: WorkRecapWindow;
      startedAt: string;
    };
    expect(body.ok).toBe(false);
    expect(body.inflight).toBe(true);
    expect(body.windowKey).toBe("7d");
    expect(new Date(body.startedAt).getTime()).toBeGreaterThan(0);

    releaseFirst();
    await firstPromise;
  });

  it("GET /latest returns null when no recap exists", async () => {
    const db = freshDb();
    const app = buildApp(db);
    const res = await app.request("http://x/api/work-recap/latest?window=7d");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; run: unknown };
    expect(body.ok).toBe(true);
    expect(body.run).toBeNull();
  });

  it("GET /list returns empty array when no recaps exist", async () => {
    const db = freshDb();
    const app = buildApp(db);
    const res = await app.request("http://x/api/work-recap/list?window=7d");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; runs: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.runs).toEqual([]);
  });

  it("GET /list rejects limit out of range", async () => {
    const db = freshDb();
    const app = buildApp(db);
    const res = await app.request("http://x/api/work-recap/list?window=7d&limit=9999");
    expect(res.status).toBe(400);
  });

  it("GET /latest/list ignore unrelated windows", async () => {
    const db = freshDb();
    // Seed a 1d run directly via insert
    db.prepare(
      `INSERT INTO work_recap_runs
         (window_key, generated_at, model, prompt_version,
          facts_json, inference_json, degraded, degrade_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "1d",
      "2026-06-09T10:00:00Z",
      "test",
      "work-recap@v1",
      JSON.stringify({}),
      JSON.stringify({}),
      0,
      null
    );

    const app = buildApp(db);
    const lat = await app.request("http://x/api/work-recap/latest?window=7d");
    expect(((await lat.json()) as { run: unknown }).run).toBeNull();
    const list = await app.request("http://x/api/work-recap/list?window=7d");
    expect(((await list.json()) as { runs: unknown[] }).runs).toEqual([]);
  });
});
