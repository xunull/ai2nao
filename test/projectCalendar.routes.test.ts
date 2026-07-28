process.env.TZ = "Asia/Shanghai";

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { createApp } from "../src/serve/app.js";

// gitleaks:全部假路径。
const REPO_A = "/w/x/ai2nao";
const P_A = "-w-x-ai2nao";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "project-calendar-r-"));
  return openDatabase(join(dir, "test.db"));
}

function seedRepo(db: Database.Database, path: string): void {
  db.prepare(
    `INSERT INTO repos (path_canonical, first_seen_at) VALUES (?, '2026-07-01T00:00:00.000Z')`
  ).run(path);
}

let seq = 0;
function seedMsg(db: Database.Database, project: string, eventAtUtc: string): void {
  seq += 1;
  db.prepare(
    `INSERT INTO agent_user_messages
      (source, source_session_id, source_message_key, project, event_at_utc,
       raw_text, raw_payload_json, cleaned_text, is_human, char_len,
       cleaner_version, parser_version, source_path, source_seen_at,
       ingested_at, updated_at)
     VALUES ('claude', @sid, @mkey, @project, @at, 'x', '{}', 'hello', 1, 5,
             1, 1, NULL, '2026-07-01T00:00:00.000Z',
             '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`
  ).run({ sid: `s${seq}`, mkey: `m${seq}`, project, at: eventAtUtc });
}

// 走 createApp 而非独立 Hono app —— 顺带验证路由确实在 createApp 里注册了(不漏「忘挂载」)。
describe("GET /api/project-calendar/month", () => {
  it("已挂载 + 返回月聚合 shape", async () => {
    const db = freshDb();
    seedRepo(db, REPO_A);
    seedMsg(db, P_A, "2026-07-10T02:00:00.000Z");

    const res = await createApp({ db }).request(
      "http://x/api/project-calendar/month?year=2026&month=7"
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      days: { day: string; projectCount: number }[];
      serverToday: string;
      dataStartDay: string | null;
    };
    expect(body.ok).toBe(true);
    expect(body.days).toHaveLength(1);
    expect(body.days[0]).toMatchObject({ day: "2026-07-10", projectCount: 1 });
    expect(body.dataStartDay).toBe("2026-07-10");
    expect(body.serverToday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("★非法月份 → 400,不是 500 也不是空态★", async () => {
    const db = freshDb();
    const res = await createApp({ db }).request(
      "http://x/api/project-calendar/month?year=2026&month=13"
    );
    expect(res.status).toBe(400);
  });

  it("缺参数 → 400", async () => {
    const db = freshDb();
    const res = await createApp({ db }).request(
      "http://x/api/project-calendar/month"
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/project-calendar/day", () => {
  it("已挂载 + 返回当日明细 shape", async () => {
    const db = freshDb();
    seedRepo(db, REPO_A);
    seedMsg(db, P_A, "2026-07-10T02:00:00.000Z");

    const res = await createApp({ db }).request(
      "http://x/api/project-calendar/day?date=2026-07-10"
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      date: string;
      projectCount: number;
      projects: { key: string; name: string }[];
      commitOnlyProjects: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.date).toBe("2026-07-10");
    expect(body.projectCount).toBe(1);
    expect(body.projects[0]).toMatchObject({ key: P_A, name: "ai2nao" });
    expect(body.commitOnlyProjects).toEqual([]);
  });

  it("★格式非法 → 400★", async () => {
    const db = freshDb();
    const res = await createApp({ db }).request(
      "http://x/api/project-calendar/day?date=2026-7-10"
    );
    expect(res.status).toBe(400);
  });

  it("★格式合法但日期不存在(2026-02-30)→ 400,不能返回空态★", async () => {
    const db = freshDb();
    const res = await createApp({ db }).request(
      "http://x/api/project-calendar/day?date=2026-02-30"
    );
    expect(res.status).toBe(400);
  });

  it("没数据的合法日期 → 200 空态(与非法输入区分开)", async () => {
    const db = freshDb();
    const res = await createApp({ db }).request(
      "http://x/api/project-calendar/day?date=2026-07-10"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projectCount: number; projects: unknown[] };
    expect(body.projectCount).toBe(0);
    expect(body.projects).toEqual([]);
  });
});

describe("GET /api/project-calendar/sync-status", () => {
  it("已挂载 + 同时给出覆盖率与进度", async () => {
    const db = freshDb();
    seedRepo(db, REPO_A);

    const res = await createApp({ db }).request(
      "http://x/api/project-calendar/sync-status"
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      coverage: { totalRepos: number; neverScanned: number; cutoffDay: string | null };
      progress: { running: boolean; done: number; total: number; lastStatus: string | null };
    };
    expect(body.ok).toBe(true);
    expect(body.coverage).toMatchObject({
      totalRepos: 1,
      neverScanned: 1,
      cutoffDay: null,
    });
    // 从未跑过 ≠ 跑过但 0 个完成
    expect(body.progress).toMatchObject({
      running: false,
      done: 0,
      total: 1,
      lastStatus: null,
    });
  });
});

describe("POST /api/project-calendar/sync-commits", () => {
  it("没有 scheduler runtime(嵌入式只读)→ 503,不是 500", async () => {
    const db = freshDb();
    const res = await createApp({ db }).request(
      "http://x/api/project-calendar/sync-commits",
      { method: "POST" }
    );
    expect(res.status).toBe(503);
  });
});
