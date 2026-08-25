import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/store/migrations.js";
import { refreshKimiWorkDuration } from "../src/workDuration/refresh.js";
import { listWorkProjectDurationUsage } from "../src/workDuration/queries.js";
import {
  isWorkDurationSource,
  WORK_DURATION_IDLE_THRESHOLD_MS,
  WORK_DURATION_SOURCES,
} from "../src/workDuration/types.js";

/**
 * 活跃时长接入 kimi —— 第四个源。
 *
 * kimi 与另外三家的结构差别只有一处：**一场会话有 N 个 agent**
 * （真库 32 场里 9 场是多 agent，最多一场 12 个）。口径定为**按会话合并**：
 * N 个 agent 的时间戳并成一条时间轴，一场会话一行，PK 仍是 `(source, session_id)`。
 *
 * 为什么不按 agent 各算再相加：真库实测合并 89.50h、相加 99.58h（+11%），
 * 最坏一场 110.4 → 454.8 分钟（4.12×）。那一场是一次派多个 subagent 并行跑 ——
 * **并行 subagent 不会让人多出时间。**
 *
 * 时间戳来自 index.db 两处，与 opencode 的 O7b 同构，
 * **不碰 `~/.kimi-code` 的任何文件**：
 *   - assistant 侧：`kimi_token_usage_event`（真库 6359 条，约每条回复 4 个采样点）
 *   - user 侧：`agent_user_messages` 的 `role='user'` 行（真库 1163 条）
 */

const T0 = Date.parse("2026-05-01T00:00:00.000Z");
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function freshDb(): Database.Database {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "ai2nao-kdur-")), "t.db"));
  migrate(db);
  return db;
}

/** 一个 agent 一行 —— 这就是 kimi 与另外三家的结构差别所在。 */
function seedAgent(
  db: Database.Database,
  o: {
    session: string;
    agent?: string;
    projectKey?: string;
    mtimeMs?: number;
    confidence?: "high" | "low";
    missing?: boolean;
    rootKind?: "cli" | "desktop";
    title?: string;
  }
): void {
  const agent = o.agent ?? "main";
  const key = o.projectKey ?? "/work/app";
  db.prepare(
    `INSERT INTO kimi_agent_token_usage
       (session_id, agent, file_path, file_mtime_ms, file_size_bytes, root_kind,
        cwd, project_key, project_path, identity_confidence, title, model,
        created_at, last_updated_at, token_status, parse_error, missing_since,
        source_seen_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'kimi-code/k3', ?, ?, 'full', null, ?, ?, ?)`
  ).run(
    o.session,
    agent,
    `/root/${o.session}/agents/${agent}/wire.jsonl`,
    o.mtimeMs ?? T0,
    o.rootKind ?? "cli",
    key,
    key,
    key,
    o.confidence ?? "high",
    o.title ?? "会话",
    iso(0),
    iso(0),
    o.missing ? iso(0) : null,
    iso(0),
    iso(0)
  );
}

/** assistant 侧时间戳走事件表，(session, agent, ordinal) 粒度。 */
let ordinal = 0;
function seedEventAt(db: Database.Database, session: string, agent: string, at: string): void {
  db.prepare(
    `INSERT INTO kimi_token_usage_event
       (session_id, agent, event_ordinal, event_at,
        fresh_input, cache_read_input, cache_creation_input, output)
     VALUES (?, ?, ?, ?, 1, 0, 0, 1)`
  ).run(session, agent, ordinal++, at);
}

/** user 侧时间戳走 agent_user_messages。role 由调用方指定 —— 用例 #1 靠它。 */
let msgKey = 0;
function seedMessageAt(
  db: Database.Database,
  session: string,
  at: string,
  role: "user" | "assistant" = "user"
): void {
  db.prepare(
    `INSERT INTO agent_user_messages
       (source, source_session_id, source_message_key, project, event_at_utc,
        raw_text, raw_payload_json, cleaned_text, is_human, char_len,
        cleaner_version, parser_version, source_path, source_seen_at,
        ingested_at, updated_at, role)
     VALUES ('kimi', ?, ?, '/work/app', ?, '问', '[]', '问', ?, 1, 1, 1,
             '/p', ?, ?, ?, ?)`
  ).run(
    session,
    `k-${msgKey++}`,
    at,
    role === "user" ? 1 : 0,
    at,
    at,
    at,
    role
  );
}

describe("kimi 时长收集器", () => {
  /**
   * 用例 #1 —— 全清单里唯一能证伪「不取 role='assistant' 的行」那条规则的断言。
   *
   * 冷读实测：真库上只取 user 是 7490 戳、user+assistant 是 9043 戳，
   * **两边 active_ms 都是 89.50h、行数都是 32、unknown 都是 0** ——
   * 因为 kimi 的 assistant aum 戳与事件表戳落在同一批密集簇里，
   * 多灌一遍不产生任何超阈值间隔。所以光断言时长**抓不到**这个错误。
   *
   * 唯一会差的是戳数，所以这里必须断言 `event_count` 与 `transcript_size_bytes`。
   */
  it("时间戳取自两处，且只取两处 —— 多灌 assistant 行不改戳数", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1" });
    seedMessageAt(db, "s1", iso(0));
    seedEventAt(db, "s1", "main", iso(60_000));
    seedMessageAt(db, "s1", iso(120_000));

    refreshKimiWorkDuration(db);
    const before = db
      .prepare(
        `SELECT event_count AS ec, transcript_size_bytes AS sz, active_ms AS am
           FROM work_session_duration WHERE source='kimi' AND session_id='s1'`
      )
      .get() as { ec: number; sz: number; am: number };
    expect(before.ec).toBe(3); // 两条 user + 一条 event
    expect(before.sz).toBe(3);
    expect(before.am).toBe(120_000);

    // 种一条落在簇内的 assistant 行。若实现漏了 role='user' 这个条件,
    // active_ms 仍是 120_000（抓不到），但戳数会变成 4。
    seedMessageAt(db, "s1", iso(90_000), "assistant");
    refreshKimiWorkDuration(db, { full: true });
    const after = db
      .prepare(
        `SELECT event_count AS ec, transcript_size_bytes AS sz, active_ms AS am
           FROM work_session_duration WHERE source='kimi' AND session_id='s1'`
      )
      .get() as { ec: number; sz: number; am: number };
    expect(after.am).toBe(120_000); // 时长确实不变 —— 这正是它测不出问题的原因
    expect(after.ec).toBe(3); // 戳数才是能证伪的那一格
    expect(after.sz).toBe(3);
    db.close();
  });

  it("N 个 agent 合并成一行，不是各算再相加", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main" });
    seedAgent(db, { session: "s1", agent: "agent-0" });
    seedAgent(db, { session: "s1", agent: "agent-1" });
    // 三个 agent 并行,时间戳交错。
    seedEventAt(db, "s1", "main", iso(0));
    seedEventAt(db, "s1", "agent-0", iso(30_000));
    seedEventAt(db, "s1", "agent-1", iso(45_000));
    seedEventAt(db, "s1", "main", iso(60_000));
    seedEventAt(db, "s1", "agent-0", iso(90_000));
    seedEventAt(db, "s1", "agent-1", iso(120_000));

    const r = refreshKimiWorkDuration(db);
    expect(r.sourceSessionCount).toBe(1); // 三个 agent 行 → 一场会话

    const rows = db
      .prepare("SELECT session_id AS sid, active_ms AS am, event_count AS ec FROM work_session_duration WHERE source='kimi'")
      .all() as { sid: string; am: number; ec: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ec).toBe(6);
    // 合并 = 墙钟跨度 120s。按 agent 相加会是 main 60 + agent-0 60 + agent-1 75 = 195s。
    expect(rows[0]!.am).toBe(120_000);
    db.close();
  });

  it("空闲阈值与另外三家同口径 —— 超过阈值的间隔按阈值截断", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1" });
    seedMessageAt(db, "s1", iso(0));
    seedMessageAt(db, "s1", iso(3_600_000));

    refreshKimiWorkDuration(db);
    const row = db
      .prepare("SELECT active_ms AS am, wall_ms AS wm FROM work_session_duration WHERE source='kimi'")
      .get() as { am: number; wm: number };
    expect(row.wm).toBe(3_600_000);
    expect(row.am).toBe(WORK_DURATION_IDLE_THRESHOLD_MS);
    db.close();
  });

  it("没有任何时间戳的会话 → unknown，不是 full 也不是丢掉", () => {
    const db = freshDb();
    seedAgent(db, { session: "quiet" });
    const r = refreshKimiWorkDuration(db);
    expect(r.durationUnknownSessionCount).toBe(1);
    const row = db
      .prepare("SELECT duration_status AS st FROM work_session_duration WHERE session_id='quiet'")
      .get() as { st: string };
    expect(row.st).toBe("unknown");
    db.close();
  });

  it("missing_since 非空的不进 —— 对应 opencode 的 archived_at", () => {
    const db = freshDb();
    seedAgent(db, { session: "gone", missing: true });
    seedMessageAt(db, "gone", iso(0));
    const r = refreshKimiWorkDuration(db);
    expect(r.sourceSessionCount).toBe(0);
    db.close();
  });

  it("增量刷新不重算：会话没变就跳过", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1" });
    seedMessageAt(db, "s1", iso(0));
    seedMessageAt(db, "s1", iso(60_000));

    const first = refreshKimiWorkDuration(db);
    expect(first.skippedUnchangedCount).toBe(0);
    const second = refreshKimiWorkDuration(db);
    expect(second.skippedUnchangedCount).toBe(1);
    expect(second.indexedSessionCount).toBe(1);
    db.close();
  });

  it("任一 agent 的 file_mtime_ms 前进就重算 —— MAX 是唯一真在做事的冲突规则", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main", mtimeMs: T0 });
    seedAgent(db, { session: "s1", agent: "agent-0", mtimeMs: T0 });
    seedMessageAt(db, "s1", iso(0));
    refreshKimiWorkDuration(db);

    // 只动第二个 agent 的 mtime。若冲突规则写成 MIN,这里会被当成没变。
    seedMessageAt(db, "s1", iso(60_000));
    db.prepare("UPDATE kimi_agent_token_usage SET file_mtime_ms=? WHERE session_id='s1' AND agent='agent-0'")
      .run(T0 + 60_000);

    const r = refreshKimiWorkDuration(db);
    expect(r.skippedUnchangedCount).toBe(0);
    const row = db
      .prepare("SELECT event_count AS ec FROM work_session_duration WHERE session_id='s1'")
      .get() as { ec: number };
    expect(row.ec).toBe(2);
    db.close();
  });

  it("表不在（旧库）→ failed，不抛", () => {
    const db = freshDb();
    db.exec("DROP TABLE kimi_agent_token_usage");
    const r = refreshKimiWorkDuration(db);
    expect(r.status).toBe("failed");
    expect(r.errors[0]).toContain("kimi_agent_token_usage");
    db.close();
  });

  it("进得了按项目的时长聚合 —— 排行页那一列真的能看到 kimi", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", projectKey: "/work/app" });
    seedMessageAt(db, "s1", iso(0));
    seedMessageAt(db, "s1", iso(60_000));
    refreshKimiWorkDuration(db);

    const m = listWorkProjectDurationUsage(db, { sources: ["kimi"] });
    expect(m.get("/work/app")!.activeMs).toBe(60_000);
    db.close();
  });

  it("kimi:conv-* 伪项目照进，不做特例过滤", () => {
    const db = freshDb();
    seedAgent(db, {
      session: "d1",
      projectKey: "kimi:conv-01605adbfb2720e3a8f5015f",
      rootKind: "desktop",
      confidence: "low",
    });
    seedMessageAt(db, "d1", iso(0));
    seedMessageAt(db, "d1", iso(60_000));
    refreshKimiWorkDuration(db);

    const m = listWorkProjectDurationUsage(db, { sources: ["kimi"] });
    expect(m.get("kimi:conv-01605adbfb2720e3a8f5015f")!.activeMs).toBe(60_000);
    db.close();
  });

  /**
   * 便宜就留着,但要知道它今天是空的:`work_session_duration.identity_confidence`
   * 是只写列(`listWorkProjectDurationUsage` 根本不 SELECT 它),
   * 且真库 32 场没有一场各 agent confidence 分歧。写反了没有可观测后果。
   */
  it("混合 confidence 的会话取 high（'high' < 'low'，所以是 MIN）", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main", confidence: "low" });
    seedAgent(db, { session: "s1", agent: "agent-0", confidence: "high" });
    seedMessageAt(db, "s1", iso(0));
    refreshKimiWorkDuration(db);

    const row = db
      .prepare("SELECT identity_confidence AS c FROM work_session_duration WHERE session_id='s1'")
      .get() as { c: string };
    expect(row.c).toBe("high");
    db.close();
  });

  it("写入边界认了 kimi —— V59 之后 schema 不再挡任何源", () => {
    expect(WORK_DURATION_SOURCES).toEqual(["claude-code", "codex", "opencode", "kimi"]);
    expect(isWorkDurationSource("kimi")).toBe(true);
    expect(isWorkDurationSource("minimax")).toBe(false); // 只在 TOKEN_SOURCES 里,无会话概念
  });
});
