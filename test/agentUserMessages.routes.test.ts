import { describe, expect, it, beforeEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { registerAgentUserMessagesRoutes } from "../src/agentUserMessages/routes.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "aum-routes-"));
  return openDatabase(join(dir, "test.db"));
}
function buildApp(db: Database.Database): Hono {
  const app = new Hono();
  registerAgentUserMessagesRoutes(app, db);
  return app;
}
const U = "http://x/api/agent-user-messages/list";

describe("GET /api/agent-user-messages/list — 校验与 happy path", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("happy(空库):200 + items=[] + nextBefore null", async () => {
    const res = await buildApp(db).request(`${U}?window=1w`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      items: unknown[];
      nextBefore: unknown;
    };
    expect(body.ok).toBe(true);
    expect(body.items).toEqual([]);
    expect(body.nextBefore).toBeNull();
  });

  it("today 窗口被接受 → 200", async () => {
    const res = await buildApp(db).request(`${U}?window=today`);
    expect(res.status).toBe(200);
  });

  it("非法 window → 400(与 /analytics 一致)", async () => {
    const res = await buildApp(db).request(`${U}?window=bogus`);
    expect(res.status).toBe(400);
  });

  it("before 无 beforeId → 400(复合游标必须成对)", async () => {
    const res = await buildApp(db).request(`${U}?window=1w&before=2026-07-05T02:00:00Z`);
    expect(res.status).toBe(400);
  });

  it("beforeId 无 before → 400", async () => {
    const res = await buildApp(db).request(`${U}?window=1w&beforeId=5`);
    expect(res.status).toBe(400);
  });

  it("非法 beforeId → 400", async () => {
    const res = await buildApp(db).request(
      `${U}?window=1w&before=2026-07-05T02:00:00Z&beforeId=abc`
    );
    expect(res.status).toBe(400);
  });

  it("非法 limit → 400", async () => {
    const res = await buildApp(db).request(`${U}?window=1w&limit=-1`);
    expect(res.status).toBe(400);
  });
});
