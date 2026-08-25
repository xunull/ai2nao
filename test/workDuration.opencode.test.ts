import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate, SCHEMA_VERSION } from "../src/store/migrations.js";
import { refreshOpencodeWorkDuration } from "../src/workDuration/refresh.js";
import { listWorkProjectDurationUsage } from "../src/workDuration/queries.js";
import {
  isWorkDurationSource,
  WORK_DURATION_IDLE_THRESHOLD_MS,
  WORK_DURATION_SOURCES,
} from "../src/workDuration/types.js";

/**
 * 活跃时长接入 opencode（O7a 去 CHECK / O7b 收集器）。
 *
 * 在此之前 `work_session_duration` 与 `work_duration_state` 的 CHECK 都只有
 * `('claude-code','codex')` —— 排行页那一列**从来只算两个源**，opencode 与 kimi
 * 都不在里面，而它读起来像项目总时长。
 *
 * O7b 与另外两家结构不同：claude/codex 要遍历 JSONL、按 mtime 跳过未变的文件；
 * opencode 的时间戳在 O3/O5 之后已全在 index.db 里，一条 SQL 就够，
 * **不碰那个 3.2 GB 的外部库**。
 */

const T0 = Date.parse("2026-05-01T00:00:00.000Z");
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function freshDb(): Database.Database {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "ai2nao-dur-")), "t.db"));
  migrate(db);
  return db;
}

function seedSession(
  db: Database.Database,
  o: { id: string; projectKey?: string; archived?: boolean; updatedAt?: string }
): void {
  const key = o.projectKey ?? "/work/app";
  db.prepare(
    `INSERT INTO opencode_session
       (session_id, directory, project_key, project_path, title, created_at,
        last_updated_at, archived_at, human_message_count, total_message_count, updated_at)
     VALUES (?, ?, ?, ?, '会话', ?, ?, ?, 0, 0, ?)`
  ).run(o.id, key, key, key, iso(0), o.updatedAt ?? iso(0), o.archived ? iso(0) : null, iso(0));
}

/** assistant 侧时间戳走事件表。 */
function seedEventAt(db: Database.Database, session: string, message: string, at: string): void {
  db.prepare(
    `INSERT INTO opencode_token_usage_event
       (session_id, message_id, event_at, fresh_input, cache_read_input,
        cache_creation_input, output, reasoning_output)
     VALUES (?, ?, ?, 1, 0, 0, 1, 0)`
  ).run(session, message, at);
}

/** user 侧时间戳走 agent_user_messages。 */
let msgKey = 0;
function seedUserAt(db: Database.Database, session: string, at: string): void {
  db.prepare(
    `INSERT INTO agent_user_messages
       (source, source_session_id, source_message_key, project, event_at_utc,
        raw_text, raw_payload_json, cleaned_text, is_human, char_len,
        cleaner_version, parser_version, source_path, source_seen_at,
        ingested_at, updated_at, role)
     VALUES ('opencode', ?, ?, '/work/app', ?, '问', '[]', '问', 1, 1, 1, 1,
             '/p', ?, ?, ?, 'user')`
  ).run(session, `k-${msgKey++}`, at, at, at, at);
}

describe("O7a —— 两张表都去掉 source 的 CHECK", () => {
  it("两张表都能写入 opencode（只改一张会在写另一张时炸）", () => {
    const db = freshDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO work_session_duration
             (source, session_id, transcript_path, transcript_mtime_ms, transcript_size_bytes,
              cwd, project_key, project_path, identity_confidence, title, wall_ms, active_ms,
              event_count, idle_threshold_ms, duration_status, source_seen_at, updated_at)
           VALUES ('opencode','s1','/p',0,0,'/w','/w','/w','high',null,0,0,0,1,'full',?,?)`
        )
        .run(iso(0), iso(0))
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO work_duration_state
             (source, rule_version, source_session_count, indexed_session_count,
              duration_known_session_count, duration_unknown_session_count,
              error_session_count, skipped_unchanged_count, updated_at)
           VALUES ('opencode',1,0,0,0,0,0,0,?)`
        )
        .run(iso(0))
    ).not.toThrow();
    db.close();
  });

  it("第五个源加进来不用再动 schema —— 约束在写入边界，不在表上", () => {
    const db = freshDb();
    // schema 层面任何源都能写(未来的 cursor/cherry 不用再重建表)。
    expect(() =>
      db
        .prepare(
          `INSERT INTO work_duration_state
             (source, rule_version, source_session_count, indexed_session_count,
              duration_known_session_count, duration_unknown_session_count,
              error_session_count, skipped_unchanged_count, updated_at)
           VALUES ('future-source',1,0,0,0,0,0,0,?)`
        )
        .run(iso(0))
    ).not.toThrow();
    // 而写入边界仍然只认已接入的四个。
    expect(WORK_DURATION_SOURCES).toEqual(["claude-code", "codex", "opencode", "kimi"]);
    expect(isWorkDurationSource("opencode")).toBe(true);
    expect(isWorkDurationSource("kimi")).toBe(true); // 已接入,见 workDuration.kimi.test.ts
    // minimax 只在 TOKEN_SOURCES 里 —— 它是 API 用量账单,没有会话概念,不该有时长。
    expect(isWorkDurationSource("minimax")).toBe(false);
    db.close();
  });

  it("重建保住了既有数据与索引", () => {
    const db = freshDb();
    expect((db.prepare("SELECT version v FROM meta_schema WHERE id=1").get() as { v: number }).v)
      .toBe(SCHEMA_VERSION);
    const idx = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='work_session_duration' AND sql IS NOT NULL"
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    // 四个索引随表消失,必须显式重建 —— 漏一个就是静默的全表扫。
    expect(idx.sort()).toEqual([
      "idx_work_duration_missing",
      "idx_work_duration_project_ended",
      "idx_work_duration_source_session",
      "idx_work_duration_transcript",
    ]);
    db.close();
  });
});

describe("O7b —— opencode 时长收集器", () => {
  it("时间戳取自 index.db 两处：事件表(assistant) + agent_user_messages(user)", () => {
    const db = freshDb();
    seedSession(db, { id: "s1" });
    seedUserAt(db, "s1", iso(0));
    seedEventAt(db, "s1", "m1", iso(60_000));
    seedUserAt(db, "s1", iso(120_000));

    const r = refreshOpencodeWorkDuration(db);
    expect(r.status).toBe("success");
    const row = db
      .prepare("SELECT event_count AS ec, active_ms AS am, wall_ms AS wm FROM work_session_duration WHERE source='opencode'")
      .get() as { ec: number; am: number; wm: number };
    expect(row.ec).toBe(3); // 两条 user + 一条 assistant
    expect(row.am).toBe(120_000);
    expect(row.wm).toBe(120_000);
    db.close();
  });

  it("空闲阈值与另外两家同口径 —— 超过阈值的间隔按阈值截断", () => {
    const db = freshDb();
    seedSession(db, { id: "s1" });
    seedUserAt(db, "s1", iso(0));
    // 隔一小时才回来:墙钟一小时,但活跃只算一个阈值。
    seedUserAt(db, "s1", iso(3_600_000));

    refreshOpencodeWorkDuration(db);
    const row = db
      .prepare("SELECT active_ms AS am, wall_ms AS wm FROM work_session_duration WHERE source='opencode'")
      .get() as { am: number; wm: number };
    expect(row.wm).toBe(3_600_000);
    expect(row.am).toBe(WORK_DURATION_IDLE_THRESHOLD_MS);
    db.close();
  });

  it("没有任何时间戳的会话 → unknown，不是 full 也不是丢掉", () => {
    const db = freshDb();
    seedSession(db, { id: "quiet" });
    const r = refreshOpencodeWorkDuration(db);
    expect(r.durationUnknownSessionCount).toBe(1);
    const row = db
      .prepare("SELECT duration_status AS st FROM work_session_duration WHERE session_id='quiet'")
      .get() as { st: string };
    expect(row.st).toBe("unknown");
    db.close();
  });

  it("已归档的会话不进 —— 与 opencode 自己的列表口径一致", () => {
    const db = freshDb();
    seedSession(db, { id: "gone", archived: true });
    seedUserAt(db, "gone", iso(0));
    const r = refreshOpencodeWorkDuration(db);
    expect(r.sourceSessionCount).toBe(0);
    db.close();
  });

  it("增量刷新不重算：会话没更新就跳过", () => {
    const db = freshDb();
    seedSession(db, { id: "s1" });
    seedUserAt(db, "s1", iso(0));
    seedUserAt(db, "s1", iso(60_000));

    const first = refreshOpencodeWorkDuration(db);
    expect(first.skippedUnchangedCount).toBe(0);
    const second = refreshOpencodeWorkDuration(db);
    expect(second.skippedUnchangedCount).toBe(1);
    expect(second.indexedSessionCount).toBe(1);
    db.close();
  });

  it("会话更新了就重算 —— 跳过判据是 last_updated_at + 条数", () => {
    const db = freshDb();
    seedSession(db, { id: "s1" });
    seedUserAt(db, "s1", iso(0));
    refreshOpencodeWorkDuration(db);

    // 新消息 + 会话时间前进
    seedUserAt(db, "s1", iso(60_000));
    db.prepare("UPDATE opencode_session SET last_updated_at=? WHERE session_id='s1'").run(iso(60_000));

    const r = refreshOpencodeWorkDuration(db);
    expect(r.skippedUnchangedCount).toBe(0);
    const row = db
      .prepare("SELECT event_count AS ec FROM work_session_duration WHERE session_id='s1'")
      .get() as { ec: number };
    expect(row.ec).toBe(2);
    db.close();
  });

  it("表不在（旧库）→ failed，不抛", () => {
    const db = freshDb();
    db.exec("DROP TABLE opencode_session");
    const r = refreshOpencodeWorkDuration(db);
    expect(r.status).toBe("failed");
    expect(r.errors[0]).toContain("opencode_session");
    db.close();
  });

  it("进得了按项目的时长聚合 —— 排行页那一列真的能看到 opencode", () => {
    const db = freshDb();
    seedSession(db, { id: "s1", projectKey: "/work/app" });
    seedUserAt(db, "s1", iso(0));
    seedUserAt(db, "s1", iso(60_000));
    refreshOpencodeWorkDuration(db);

    const m = listWorkProjectDurationUsage(db, { sources: ["opencode"] });
    expect(m.get("/work/app")!.activeMs).toBe(60_000);
    db.close();
  });
});
