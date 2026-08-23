import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/store/migrations.js";
import {
  ingestOpencodeUserMessages,
  OPENCODE_INGEST_VERSION,
} from "../src/agentUserMessages/opencodeIngest.js";
import { getSyncState, setSyncState } from "../src/agentUserMessages/store.js";

/**
 * opencode ingest 的水位。
 *
 * 在这组用例之前，claude 与 codex 各有一个 `*Ingest.watermark.test.ts`，
 * **opencode 没有**，而 `ingestOpencodeUserMessages` 在全测试套件里零处引用。
 * 那个空缺正是下面这个 bug 能活着丢掉真库 28% 数据的原因。
 *
 * 原代码里有两个时钟在交叉：
 *
 * ```
 *   const todo = sessions.filter(s => s.timeUpdatedMs >= watermark);  // session 按 timeUpdated
 *   for (batch of todo) {
 *     for (const m of messages) {
 *       if (m.timeCreated < watermark) continue;        // 消息按 timeCreated
 *       if (m.timeCreated > batchMaxMs) batchMaxMs = m.timeCreated;
 *     }
 *     if (batchMaxMs > watermark) watermark = batchMaxMs;   // 循环内改写
 *   }
 * ```
 *
 * 第 1 批把水位推到它最新消息的**创建**时间之后，第 2 批里那些
 * 「早创建、晚更新」的 session 的老消息就全部 `< watermark` 被跳过。
 * 而且不自愈 —— 下一轮 `timeUpdatedMs >= watermark` 会把整个 session 滤掉。
 *
 * 真库实测：源侧 1934 条 user 消息，入库只有 1384 条，丢了 550 条（28.4%）。
 */

const T0 = Date.parse("2026-05-01T00:00:00.000Z");
const BATCH_SESSIONS = 50; // 与 opencodeIngest.ts 保持一致

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-oc-wm-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function indexDb(): Database.Database {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "ai2nao-oc-idx-")), "index.db"));
  migrate(db);
  return db;
}

/**
 * 造一个跨批的「早创建、晚更新」场景：
 *   - 50 个填充 session，消息时间**新**（把第 1 批的水位推高）
 *   - 第 51 个 session `time_updated` 最大（排序在最后 → 落到第 2 批），
 *     但它的消息**很旧**
 * 修复前：第 51 个的消息 < 水位 → 被跳过，只入 50 条。
 */
function makeOpencodeDb(dir: string): void {
  const db = new Database(join(dir, "opencode.db"));
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
      model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
      tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, cost REAL DEFAULT 0
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER, data TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO project VALUES (?,?,?,?,?)").run("p1", "/work/app", "app", T0, T0 + 99999);

  const sess = db.prepare(
    `INSERT INTO session (id,project_id,directory,title,model,agent,time_created,time_updated,
                          time_archived,tokens_input,tokens_output,cost)
     VALUES (?,?,?,?,null,null,?,?,null,0,0,0)`
  );
  const msg = db.prepare("INSERT INTO message (id,session_id,time_created,data) VALUES (?,?,?,?)");
  const part = db.prepare("INSERT INTO part (id,message_id,session_id,time_created,data) VALUES (?,?,?,?,?)");

  const addMessage = (sid: string, mid: string, createdMs: number, text: string): void => {
    msg.run(mid, sid, createdMs, JSON.stringify({ role: "user", time: { created: createdMs } }));
    part.run(`${mid}-p`, mid, sid, createdMs, JSON.stringify({ type: "text", text }));
  };

  // 第 1 批：50 个 session，消息时间新 → 把水位推到 T0+5000 之后
  for (let i = 0; i < BATCH_SESSIONS; i++) {
    const sid = `filler-${String(i).padStart(2, "0")}`;
    sess.run(sid, "p1", "/work/app", `填充 ${i}`, T0, T0 + 1000 + i);
    addMessage(sid, `${sid}-m`, T0 + 5000 + i, `新消息 ${i}`);
  }

  // 第 2 批：更新时间最大（排最后），但消息很旧 —— 就是被吞掉的那一类
  sess.run("late-touched", "p1", "/work/app", "早创建晚更新", T0, T0 + 90000);
  addMessage("late-touched", "late-m", T0 + 100, "这条老消息不该被吞掉");

  db.close();
}

describe("opencode ingest 水位", () => {
  it("「早创建、晚更新」的 session 的老消息不会被跳过", () => {
    const dir = makeDir();
    makeOpencodeDb(dir);
    const db = indexDb();

    const r = ingestOpencodeUserMessages(db, { dataDir: dir });
    expect(r.status).toBe("success");

    const rows = db
      .prepare("SELECT source_session_id AS sid FROM agent_user_messages WHERE source='opencode'")
      .all() as { sid: string }[];

    // 修复前这里是 50 —— late-touched 的消息 (T0+100) 小于第 1 批推上去的水位。
    expect(rows).toHaveLength(BATCH_SESSIONS + 1);
    expect(rows.map((x) => x.sid)).toContain("late-touched");
    db.close();
  });

  it("水位只跟 session 的 timeUpdated，不跟消息的 timeCreated", () => {
    const dir = makeDir();
    makeOpencodeDb(dir);
    const db = indexDb();

    ingestOpencodeUserMessages(db, { dataDir: dir });
    const state = getSyncState(db, "opencode")!;

    // 最大的 timeUpdated 是 late-touched 的 T0+90000。若水位来自消息的
    // timeCreated，它会停在 T0+5049 —— 两个时钟一交叉就是原来那个 bug。
    expect(state.watermarkMs).toBe(T0 + 90000);
    db.close();
  });

  it("重跑幂等：行数不增不减", () => {
    const dir = makeDir();
    makeOpencodeDb(dir);
    const db = indexDb();

    ingestOpencodeUserMessages(db, { dataDir: dir });
    const first = db
      .prepare("SELECT COUNT(*) n FROM agent_user_messages WHERE source='opencode'")
      .get() as { n: number };

    ingestOpencodeUserMessages(db, { dataDir: dir });
    const second = db
      .prepare("SELECT COUNT(*) n FROM agent_user_messages WHERE source='opencode'")
      .get() as { n: number };

    expect(second.n).toBe(first.n);
    expect(first.n).toBe(BATCH_SESSIONS + 1);
    db.close();
  });

  describe("ingest_version 自愈（V56）", () => {
    it("版本号不符时强制全量，把水位挡住的行补回来", () => {
      const dir = makeDir();
      makeOpencodeDb(dir);
      const db = indexDb();

      // 模拟一台既有装机：水位已经很高（挡住一切），版本号是旧的 0。
      setSyncState(db, "opencode", {
        watermarkMs: T0 + 999999,
        lastRunAt: new Date(T0).toISOString(),
        lastStatus: "success",
        lastError: null,
        ingestVersion: 0,
      });

      const r = ingestOpencodeUserMessages(db, { dataDir: dir });
      expect(r.status).toBe("success");

      // 版本号不符 → 本轮水位归零 → 全部重扫。没有这一条，既有装机会永久少 28%。
      const n = db
        .prepare("SELECT COUNT(*) n FROM agent_user_messages WHERE source='opencode'")
        .get() as { n: number };
      expect(n.n).toBe(BATCH_SESSIONS + 1);
      db.close();
    });

    it("整轮成功才推进版本号", () => {
      const dir = makeDir();
      makeOpencodeDb(dir);
      const db = indexDb();

      ingestOpencodeUserMessages(db, { dataDir: dir });
      // 锚在常量上而不是写死数字 —— 上一版写了 toBe(1),口径一 bump 就假红。
      expect(getSyncState(db, "opencode")!.ingestVersion).toBe(OPENCODE_INGEST_VERSION);
      db.close();
    });

    it("版本号已是最新时不再强制全量（水位照常生效）", () => {
      const dir = makeDir();
      makeOpencodeDb(dir);
      const db = indexDb();

      ingestOpencodeUserMessages(db, { dataDir: dir });
      // 人为把水位推到所有 session 之后；版本号已是最新，不该再触发全量。
      setSyncState(db, "opencode", {
        watermarkMs: T0 + 999999,
        lastRunAt: new Date(T0).toISOString(),
        lastStatus: "success",
        lastError: null,
        ingestVersion: OPENCODE_INGEST_VERSION,
      });

      const r = ingestOpencodeUserMessages(db, { dataDir: dir });
      expect(r.scannedSessions).toBe(0); // 全被 session 级水位滤掉
      db.close();
    });

    it("库打不开时不推进版本号 —— 下轮仍会触发全量", () => {
      const emptyDir = makeDir(); // 没有 opencode.db
      const db = indexDb();
      setSyncState(db, "opencode", {
        watermarkMs: 0,
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        ingestVersion: 0,
      });

      const r = ingestOpencodeUserMessages(db, { dataDir: emptyDir });
      expect(r.status).toBe("skipped");
      expect(getSyncState(db, "opencode")!.ingestVersion).toBe(0);
      db.close();
    });
  });
});
