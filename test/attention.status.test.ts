import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATTENTION_TASK_KEY,
  getAttentionStatus,
  STALE_AFTER_MS,
} from "../src/attention/status.js";
import { migrate } from "../src/store/migrations.js";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai2nao-attn-status-"));
  db = new DatabaseCtor(":memory:");
  migrate(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A readable knowledgeC-shaped source with the focus stream present. */
function goodSource(name = "kc.db"): string {
  const p = join(dir, name);
  const src = new DatabaseCtor(p);
  src.exec(`
    CREATE TABLE ZOBJECT (
      Z_PK INTEGER PRIMARY KEY, ZSTREAMNAME TEXT, ZVALUESTRING TEXT,
      ZSTARTDATE REAL, ZENDDATE REAL, ZSECONDSFROMGMT INTEGER
    );
    INSERT INTO ZOBJECT (ZSTREAMNAME, ZVALUESTRING, ZSTARTDATE, ZENDDATE)
    VALUES ('/app/usage', 'com.example.a', 800000000, 800000060);
  `);
  src.close();
  return p;
}

function recordRun(status: string, finishedAt: string): void {
  // scheduled_task_runs has a foreign key onto scheduled_tasks, so the task has
  // to exist first. Registering it with enabled = 0 mirrors what the scheduler
  // actually does: every task in this project is born disabled.
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_tasks (task_key, enabled, interval_seconds, created_at, updated_at)
     VALUES (?, 0, 3600, 'x', 'x')`
  ).run(ATTENTION_TASK_KEY);
  db.prepare(
    `INSERT INTO scheduled_task_runs (task_key, trigger, started_at, finished_at, status)
     VALUES (?, 'manual', ?, ?, ?)`
  ).run(ATTENTION_TASK_KEY, finishedAt, finishedAt, status);
}

const allowRuntime = () => vi.stubEnv("AI2NAO_ATTENTION_ALLOW_ANY_RUNTIME", "1");

describe("getAttentionStatus", () => {
  it("refuses a non-packaged runtime before touching the source", () => {
    // D5: Full Disk Access is granted per executable. A shared `node` binary
    // holding it would give every node script on the machine full-disk read.
    const s = getAttentionStatus(db, { sourcePath: goodSource() });
    expect(s.status).toBe("unsupported_runtime");
    expect(s.action).toMatch(/ai2nao\.app/);
  });

  it("reports not_authorized and names the app that needs the grant", () => {
    allowRuntime();
    const p = goodSource("locked.db");
    chmodSync(p, 0o000);
    const s = getAttentionStatus(db, { sourcePath: p });
    chmodSync(p, 0o644);
    if (s.status === "ok") return; // running as root defeats chmod
    expect(s.status).toBe("not_authorized");
    expect(s.action).toMatch(/完全磁盘访问/);
  });

  it("separates an unreadable source from an unauthorized one", () => {
    allowRuntime();
    const p = join(dir, "garbage.db");
    writeFileSync(p, "not a database at all");
    const s = getAttentionStatus(db, { sourcePath: p });
    expect(s.status).toBe("source_unavailable");
    // Telling the user to grant access here would waste a real privacy decision.
    expect(s.action ?? "").not.toMatch(/完全磁盘访问/);
  });

  it("reports never_run when the task has no successful run", () => {
    allowRuntime();
    const s = getAttentionStatus(db, { sourcePath: goodSource() });
    expect(s.status).toBe("never_run");
    expect(s.action).toMatch(/scheduler/);
    expect(s.lastSuccessAt).toBeNull();
  });

  it("still reports never_run when every run failed", () => {
    // The judgement is on successes, not on whether the task was ever invoked.
    allowRuntime();
    recordRun("failed", new Date().toISOString());
    const s = getAttentionStatus(db, { sourcePath: goodSource() });
    expect(s.status).toBe("never_run");
    expect(s.lastRunAt).not.toBeNull();
  });

  it("reports stale when the last success is older than the window", () => {
    // This is the git_commits failure mode: the table had a reader, no writer,
    // and sat 22 days behind while the page rendered "0 commits" without a word.
    allowRuntime();
    const now = Date.now();
    recordRun("success", new Date(now - STALE_AFTER_MS - 60_000).toISOString());
    const s = getAttentionStatus(db, { sourcePath: goodSource(), now });
    expect(s.status).toBe("stale");
    expect(s.message).toMatch(/天前/);
  });

  it("reports ok when a recent success exists", () => {
    allowRuntime();
    const now = Date.now();
    recordRun("success", new Date(now - 60_000).toISOString());
    const s = getAttentionStatus(db, { sourcePath: goodSource(), now });
    expect(s.status).toBe("ok");
    expect(s.action).toBeUndefined();
  });

  it("never judges health from the enabled flag", () => {
    // Every scheduler task in this project registers with enabled = 0, so the
    // flag carries no information about whether a source is healthy.
    allowRuntime();
    const now = Date.now();
    recordRun("success", new Date(now - 60_000).toISOString());
    db.prepare("UPDATE scheduled_tasks SET enabled = 0 WHERE task_key = ?").run(
      ATTENTION_TASK_KEY
    );
    expect(getAttentionStatus(db, { sourcePath: goodSource(), now }).status).toBe("ok");
  });

  it("carries span coverage regardless of state", () => {
    allowRuntime();
    db.prepare(
      `INSERT INTO attention_focus_spans
         (source, source_instance_id, source_row_id, part_index, bundle_id,
          start_ms, end_ms, duration_ms, local_day, inserted_at)
       VALUES ('knowledgec','i',1,0,'com.example.a',1000,2000,1000,'2026-08-10','x')`
    ).run();
    const s = getAttentionStatus(db, { sourcePath: goodSource() });
    expect(s.spanCount).toBe(1);
    expect(s.coverageFromMs).toBe(1000);
    expect(s.coverageToMs).toBe(2000);
  });
});

describe("授权引导按运行时分叉", () => {
  it("在壳里跑时指向菜单栏那个入口", () => {
    // 网页跳不了 x-apple.systempreferences:，只有壳能打开那个面板。不提这一句，
    // 用户不会知道菜单里有入口，只能自己去系统设置里翻。
    vi.stubEnv("AI2NAO_ATTENTION_ALLOW_ANY_RUNTIME", "1");
    const p = goodSource("shell.db");
    chmodSync(p, 0o000);
    const orig = Object.getOwnPropertyDescriptor(process.versions, "electron");
    Object.defineProperty(process.versions, "electron", {
      value: "43.0.0",
      configurable: true,
    });
    const s = getAttentionStatus(db, { sourcePath: p });
    if (orig) Object.defineProperty(process.versions, "electron", orig);
    else delete (process.versions as Record<string, unknown>).electron;
    chmodSync(p, 0o644);
    if (s.status !== "not_authorized") return; // root 下 chmod 无效
    expect(s.action).toMatch(/完全磁盘访问设置/);
  });
});
