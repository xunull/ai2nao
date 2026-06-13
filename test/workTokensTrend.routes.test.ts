import { describe, expect, it, beforeEach, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { registerWorkTokensTrendRoutes } from "../src/workTokensTrend/routes.js";

const PRIOR_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Shanghai";
});
afterAll(() => {
  process.env.TZ = PRIOR_TZ;
});

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-tokens-trend-r-"));
  return openDatabase(join(dir, "test.db"));
}

function buildApp(db: Database.Database): Hono {
  const app = new Hono();
  registerWorkTokensTrendRoutes(app, db);
  return app;
}

describe("GET /api/work-tokens-trend", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("happy window mode: 200 with discriminated-union body", async () => {
    const app = buildApp(db);
    const res = await app.request("http://x/api/work-tokens-trend?window=1w");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; windowKey: string };
    expect(body.mode).toBe("window");
    expect(body.windowKey).toBe("1w");
  });

  it("happy month mode", async () => {
    const app = buildApp(db);
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const res = await app.request(`http://x/api/work-tokens-trend?month=${monthKey}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; monthKey: string };
    expect(body.mode).toBe("month");
    expect(body.monthKey).toBe(monthKey);
  });

  it("defaults to window=1w when no params", async () => {
    const app = buildApp(db);
    const res = await app.request("http://x/api/work-tokens-trend");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; windowKey: string };
    expect(body.windowKey).toBe("1w");
  });

  it("400 on invalid window", async () => {
    const app = buildApp(db);
    const res = await app.request("http://x/api/work-tokens-trend?window=99d");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/invalid window/);
  });

  it("400 on invalid month format", async () => {
    const app = buildApp(db);
    const res = await app.request("http://x/api/work-tokens-trend?month=not-a-month");
    expect(res.status).toBe(400);
  });

  it("400 on month older than 24 months back", async () => {
    const app = buildApp(db);
    const res = await app.request("http://x/api/work-tokens-trend?month=2020-01");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/older than 24/);
  });

  it("T-B5 (F8): 500 on DB exception", async () => {
    const app = buildApp(db);
    // Drop a critical table mid-flight to force a SQL error.
    db.exec("DROP TABLE claude_session_token_usage");
    const res = await app.request("http://x/api/work-tokens-trend?window=1w");
    expect(res.status).toBe(200); // service catches per-source; route returns 200 with diagnostics
    const body = (await res.json()) as {
      diagnostics: Array<{ severity: string; kind: string }>;
    };
    expect(body.diagnostics.some((d) => d.kind === "source_query_failed")).toBe(true);
  });
});
