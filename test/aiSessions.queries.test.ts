process.env.TZ = "Asia/Shanghai";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/store/migrations.js";
import { dailySessions, daySessionDetail } from "../src/aiSessions/queries.js";

/**
 * 每天有多少 AI 会话。
 *
 * 口径是这个功能的全部难点：真库实测 **42.3% 的 claude 会话跨天**，最长跨 56 天。
 * 所以「一场会话算哪天的」不是记账细节 ——「按开始日」会让今天显示成
 * 「零 AI 会话」（整天都在续旧会话）。
 *
 * 选定：**按有活动的天** —— 那天只要跟这场会话有来往就计一次。
 *
 * 两条线都建在 `agent_user_messages` 上，天然同集合：
 *   在用 = 每个有消息的天各计一次
 *   新开 = 每场会话的**首条消息日**，只计一次
 * （上一版设计想让「新开」取 `work_session_duration.started_at` 并用
 *  `missing_since IS NULL` 过滤，被对抗性冷读用真库证伪：那个过滤砍掉的是
 *  **有消息**的会话——claude 191 场只剩 95——而最大的差异
 *  （codex 93 场有时长、非 missing、零消息）它根本碰不到。）
 *
 * TZ 钉死在第 1 行：`date(...,'localtime')` 会让跨天用例随机器时区飘，
 * 这是仓库既有约定（projectCalendar / aiRhythm 等 6 个测试文件都这么写）。
 */

function freshDb(): Database.Database {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "ai2nao-sess-")), "t.db"));
  migrate(db);
  return db;
}

let seq = 0;
/** 种一条消息。`at` 是本地时刻（会转成 UTC 存），不带时区后缀。 */
function seedMsg(
  db: Database.Database,
  o: { session: string; at: string; source?: string; project?: string }
): void {
  const source = o.source ?? "claude";
  // 输入按 Asia/Shanghai 解释，存 UTC —— 与真实 ingest 一致。
  const utc = new Date(`${o.at}+08:00`).toISOString();
  db.prepare(
    `INSERT INTO agent_user_messages
       (source, source_session_id, source_message_key, project, event_at_utc,
        raw_text, raw_payload_json, cleaned_text, is_human, char_len,
        cleaner_version, parser_version, source_path, source_seen_at,
        ingested_at, updated_at, role)
     VALUES (?, ?, ?, ?, ?, '问', '[]', '问', 1, 1, 1, 1, '/p', ?, ?, ?, 'user')`
  ).run(source, o.session, `k-${seq++}`, o.project ?? "/work/app", utc, utc, utc, utc);
}

const dayMap = (rows: { day: string; sessions: number }[]) =>
  new Map(rows.map((r) => [r.day, r.sessions]));

describe("按有活动的天计数（主口径）", () => {
  /**
   * 这一条是整个设计的主验收。三种误实现各自会被哪一句抓到：
   *   按开始日        → D3 / D5 变 0
   *   span fill(起止之间每一天都算) → D2 / D4 变 1  ← **只有显式断言 0 才抓得到**
   *   按 UTC 日而非本地日 → 见下面「跨本地午夜」那条
   */
  it("一场会话在 D1/D3/D5 有消息 → 那三天各 +1，D2/D4 是 0", () => {
    const db = freshDb();
    for (const d of ["01", "03", "05"]) {
      seedMsg(db, { session: "s1", at: `2026-06-${d}T10:00:00` });
    }

    const m = dayMap(dailySessions(db, { from: "2026-06-01", to: "2026-06-06" }).active);
    expect(m.get("2026-06-01")).toBe(1);
    expect(m.get("2026-06-03")).toBe(1);
    expect(m.get("2026-06-05")).toBe(1);
    // 这两句缺一不可 —— 少了它们，「起止之间每一天都算」的误实现照样绿。
    expect(m.get("2026-06-02") ?? 0).toBe(0);
    expect(m.get("2026-06-04") ?? 0).toBe(0);
    db.close();
  });

  /** 唯一能把 date(x,'localtime') 和 date(x) 分开的用例。 */
  it("跨本地午夜的会话落在两天（TZ 钉死 Asia/Shanghai）", () => {
    const db = freshDb();
    seedMsg(db, { session: "s1", at: "2026-06-10T23:50:00" });
    seedMsg(db, { session: "s1", at: "2026-06-11T00:10:00" });

    const m = dayMap(dailySessions(db, { from: "2026-06-10", to: "2026-06-12" }).active);
    expect(m.get("2026-06-10")).toBe(1);
    expect(m.get("2026-06-11")).toBe(1);
    // 按 UTC 日算的话两条都会落在 06-10（15:50Z 与 16:10Z）。
    db.close();
  });

  it("同一天的多场会话各计一次，同一场的多条消息只计一次", () => {
    const db = freshDb();
    seedMsg(db, { session: "a", at: "2026-06-01T09:00:00" });
    seedMsg(db, { session: "a", at: "2026-06-01T18:00:00" });
    seedMsg(db, { session: "b", at: "2026-06-01T12:00:00" });

    const m = dayMap(dailySessions(db, { from: "2026-06-01", to: "2026-06-02" }).active);
    expect(m.get("2026-06-01")).toBe(2);
    db.close();
  });
});

describe("「新开」线", () => {
  it("每场会话只在它的首条消息日计一次", () => {
    const db = freshDb();
    for (const d of ["01", "03", "05"]) {
      seedMsg(db, { session: "s1", at: `2026-06-${d}T10:00:00` });
    }
    seedMsg(db, { session: "s2", at: "2026-06-03T10:00:00" });

    const r = dailySessions(db, { from: "2026-06-01", to: "2026-06-06" });
    const started = dayMap(r.started);
    expect(started.get("2026-06-01")).toBe(1); // s1 首日
    expect(started.get("2026-06-03")).toBe(1); // s2 首日（s1 不再计）
    expect(started.get("2026-06-05") ?? 0).toBe(0);
    db.close();
  });

  it("两条线同集合 —— 新开的总数等于会话总数", () => {
    const db = freshDb();
    for (const d of ["01", "03", "05"]) seedMsg(db, { session: "s1", at: `2026-06-${d}T10:00:00` });
    seedMsg(db, { session: "s2", at: "2026-06-03T10:00:00" });
    seedMsg(db, { session: "s3", at: "2026-06-05T10:00:00", source: "codex" });

    const r = dailySessions(db, { from: "2026-06-01", to: "2026-06-06" });
    const startedTotal = r.started.reduce((n, x) => n + x.sessions, 0);
    expect(startedTotal).toBe(3); // s1 / s2 / s3
    // 在用 ≥ 新开，差值就是纯粹的「续用旧会话」。
    const activeTotal = r.active.reduce((n, x) => n + x.sessions, 0);
    expect(activeTotal).toBeGreaterThan(startedTotal);
    db.close();
  });
});

describe("跨源", () => {
  it("逐源拆分，且合计等于逐源之和", () => {
    const db = freshDb();
    seedMsg(db, { session: "c1", at: "2026-06-01T10:00:00", source: "claude" });
    seedMsg(db, { session: "x1", at: "2026-06-01T10:00:00", source: "codex" });
    seedMsg(db, { session: "k1", at: "2026-06-01T10:00:00", source: "kimi" });

    const r = dailySessions(db, { from: "2026-06-01", to: "2026-06-02" });
    const day = r.active.find((x) => x.day === "2026-06-01")!;
    expect(day.sessions).toBe(3);
    expect(day.bySource).toEqual({ claude: 1, codex: 1, kimi: 1 });
    db.close();
  });

  /**
   * 合计必须按 (source, session_id) 去重。真库今天跨源 session_id 碰撞为 0,
   * 所以这条**只能靠构造** —— 拿真库测永远绿。
   */
  it("两个源用了同一个 session_id → 算两场，不是一场", () => {
    const db = freshDb();
    seedMsg(db, { session: "same-id", at: "2026-06-01T10:00:00", source: "claude" });
    seedMsg(db, { session: "same-id", at: "2026-06-01T11:00:00", source: "codex" });

    const day = dailySessions(db, { from: "2026-06-01", to: "2026-06-02" }).active[0]!;
    expect(day.sessions).toBe(2); // 顶层写成不带 source 的 COUNT(DISTINCT) 会是 1
    db.close();
  });
});

describe("下钻", () => {
  it("列出当天的会话；没有时长记录的也要在，用 id 兜底", () => {
    const db = freshDb();
    seedMsg(db, { session: "has-dur", at: "2026-06-01T10:00:00", source: "claude" });
    seedMsg(db, { session: "orphan", at: "2026-06-01T11:00:00", source: "kimi" });
    // 只给第一场种 duration 行（注意 source 名映射 claude → claude-code）。
    db.prepare(
      `INSERT INTO work_session_duration
         (source, session_id, transcript_path, transcript_mtime_ms, transcript_size_bytes,
          cwd, project_key, project_path, identity_confidence, title, wall_ms, active_ms,
          event_count, idle_threshold_ms, duration_status, source_seen_at, updated_at)
       VALUES ('claude-code','has-dur','/p',0,0,'/w','/w','/w','high','写测试',600000,300000,2,600000,'full',?,?)`
    ).run("2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z");

    const rows = daySessionDetail(db, "2026-06-01");
    expect(rows).toHaveLength(2);
    const withTitle = rows.find((r) => r.sessionId === "has-dur")!;
    expect(withTitle.title).toBe("写测试");
    expect(withTitle.activeMs).toBe(300000);
    // 孤儿：没有 duration 行 → 没有 title，但必须出现在列表里。
    const orphan = rows.find((r) => r.sessionId === "orphan")!;
    expect(orphan.title).toBeNull();
    expect(orphan.activeMs).toBeNull();
    db.close();
  });
});
