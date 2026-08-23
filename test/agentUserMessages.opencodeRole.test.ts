import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/store/migrations.js";
import { ingestOpencodeUserMessages } from "../src/agentUserMessages/opencodeIngest.js";

/**
 * opencode 的 AI 正文入库 + 逐消息 token 事件（O2/O3）。
 *
 * 此前 `myMessages.ts:204` 的 `if (role !== "user") return null` 把 AI 正文
 * 一字不漏地挡在外面：真库里 claude 有 14176 条 assistant、codex 25789 条、
 * kimi 1500 条，opencode **0 条**。
 *
 * 这组用例盯住三件最容易做错的事：
 *
 * 1. **`role` 字段。** `store.ts:61` 是 `role: input.role ?? "user"` —— 不显式传
 *    就静默落成 `'user'`，而搜索页「AI 说的」筛子是 `queries.ts:68` 的
 *    `m.role = 'assistant'`。漏了它，行数/字节数/is_human 每条断言都能过，
 *    而「搜得到 opencode 说过什么」返回 0 条。这是唯一一条「验收全过、目标全废」
 *    的路径，所以第一个用例就查它。
 *
 * 2. **两个人口不是一个数。** 正文侧只收有 text part 的 assistant 轮；
 *    token 事件要**全部** assistant 轮（量挂在消息上，不挂在正文上）。
 *    真库是 2260 vs 7430，差 3.3 倍。
 *
 * 3. **assistant 的 `raw_payload_json` 只存正文。** 它的 tool part 实测 166.29 MB，
 *    全留底会往库里加 184 MB —— 比正在修的 58 MB 问题糟三倍。
 */

const T0 = Date.parse("2026-05-01T00:00:00.000Z");

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-oc-role-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function indexDb(): Database.Database {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "ai2nao-oc-ridx-")), "index.db"));
  migrate(db);
  return db;
}

/**
 * 一场会话，覆盖四种 assistant 轮：
 *   a1  有正文 + 有 token        → 正文侧收，事件侧收
 *   a2  只有 tool（无正文）+ token → 正文侧**不收**，事件侧收
 *   a3  有正文，无 token          → 正文侧收，事件侧不收
 *   a4  只有 reasoning（无 text） → 两侧都不收（不存思考正文）
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
  db.prepare("INSERT INTO project VALUES (?,?,?,?,?)").run("p1", "/work/app", "app", T0, T0 + 9000);
  db.prepare(
    `INSERT INTO session (id,project_id,directory,title,model,agent,time_created,time_updated,
                          time_archived,tokens_input,tokens_output,cost)
     VALUES ('s1','p1','/work/app','会话',null,null,?,?,null,0,0,0)`
  ).run(T0, T0 + 9000);

  const msg = db.prepare("INSERT INTO message (id,session_id,time_created,data) VALUES (?,?,?,?)");
  const part = db.prepare("INSERT INTO part (id,message_id,session_id,time_created,data) VALUES (?,?,?,?,?)");
  const TOKENS = { total: 1170, input: 100, output: 20, reasoning: 7, cache: { read: 900, write: 143 } };

  msg.run("u1", "s1", T0 + 100, JSON.stringify({ role: "user", time: { created: T0 + 100 } }));
  part.run("u1p", "u1", "s1", T0 + 100, JSON.stringify({ type: "text", text: "帮我加个功能" }));

  msg.run("a1", "s1", T0 + 200, JSON.stringify({ role: "assistant", time: { created: T0 + 200 }, tokens: TOKENS }));
  part.run("a1p1", "a1", "s1", T0 + 200, JSON.stringify({ type: "reasoning", text: "先看代码结构" }));
  part.run("a1p2", "a1", "s1", T0 + 201, JSON.stringify({ type: "text", text: "好的我来做" }));
  // 一个体积很大的 tool part —— 它绝不能进 raw_payload_json。
  part.run("a1p3", "a1", "s1", T0 + 202, JSON.stringify({
    type: "tool", tool: "read",
    state: { status: "completed", input: { path: "a.ts" }, output: "X".repeat(50000) },
  }));

  msg.run("a2", "s1", T0 + 300, JSON.stringify({ role: "assistant", time: { created: T0 + 300 }, tokens: TOKENS }));
  part.run("a2p", "a2", "s1", T0 + 300, JSON.stringify({ type: "tool", tool: "bash", state: { status: "completed" } }));

  msg.run("a3", "s1", T0 + 400, JSON.stringify({ role: "assistant", time: { created: T0 + 400 } }));
  part.run("a3p", "a3", "s1", T0 + 400, JSON.stringify({ type: "text", text: "没有 token 的一轮" }));

  msg.run("a4", "s1", T0 + 500, JSON.stringify({ role: "assistant", time: { created: T0 + 500 } }));
  part.run("a4p", "a4", "s1", T0 + 500, JSON.stringify({ type: "reasoning", text: "只有思考,不该入库" }));

  db.close();
}

function run(): Database.Database {
  const dir = makeDir();
  makeOpencodeDb(dir);
  const db = indexDb();
  ingestOpencodeUserMessages(db, { dataDir: dir });
  return db;
}

describe("opencode AI 正文入库", () => {
  it("assistant 行的 role 是 'assistant' —— 唯一一条「验收全过、目标全废」的路径", () => {
    const db = run();
    const rows = db
      .prepare(
        "SELECT source_message_key AS k, role, is_human AS h FROM agent_user_messages WHERE source='opencode' ORDER BY k"
      )
      .all() as { k: string; role: string; h: number }[];

    // 不显式传 role 的话这里全是 'user',而下面每条断言仍然会绿。
    const asst = rows.filter((r) => r.role === "assistant");
    expect(asst.map((r) => r.k)).toEqual(["a1", "a3"]);
    expect(rows.find((r) => r.k === "u1")!.role).toBe("user");
    db.close();
  });

  it("assistant 行 is_human=0，且 answering_user_key 指向上一条 user", () => {
    const db = run();
    const a1 = db
      .prepare(
        "SELECT is_human AS h, answering_user_key AS k FROM agent_user_messages WHERE source='opencode' AND source_message_key='a1'"
      )
      .get() as { h: number; k: string | null };
    expect(a1.h).toBe(0);
    expect(a1.k).toBe("u1");
    db.close();
  });

  it("AI 正文不经清洗 —— 它不会往自己嘴里塞 system-reminder", () => {
    const db = run();
    const a1 = db
      .prepare(
        "SELECT raw_text AS raw, cleaned_text AS cleaned FROM agent_user_messages WHERE source='opencode' AND source_message_key='a1'"
      )
      .get() as { raw: string; cleaned: string };
    expect(a1.cleaned).toBe(a1.raw);
    expect(a1.cleaned).toBe("好的我来做");
    db.close();
  });

  it("正文只取 text part —— reasoning 不入库（与另外三家一致）", () => {
    const db = run();
    const keys = (
      db
        .prepare("SELECT source_message_key AS k FROM agent_user_messages WHERE source='opencode'")
        .all() as { k: string }[]
    ).map((r) => r.k);
    // a4 只有 reasoning → 两侧都不收
    expect(keys).not.toContain("a4");
    const a1 = db
      .prepare("SELECT cleaned_text AS c FROM agent_user_messages WHERE source='opencode' AND source_message_key='a1'")
      .get() as { c: string };
    expect(a1.c).not.toContain("先看代码结构");
    db.close();
  });

  it("空正文的轮整行不写 —— 否则会污染 FTS", () => {
    const db = run();
    const keys = (
      db
        .prepare("SELECT source_message_key AS k FROM agent_user_messages WHERE source='opencode'")
        .all() as { k: string }[]
    ).map((r) => r.k);
    expect(keys).not.toContain("a2"); // 只有 tool part
    const empties = db
      .prepare("SELECT COUNT(*) n FROM agent_user_messages WHERE source='opencode' AND trim(cleaned_text)=''")
      .get() as { n: number };
    expect(empties.n).toBe(0);
    db.close();
  });

  it("assistant 的 raw_payload_json 只存正文，不含 tool part", () => {
    const db = run();
    const a1 = db
      .prepare("SELECT raw_payload_json AS p FROM agent_user_messages WHERE source='opencode' AND source_message_key='a1'")
      .get() as { p: string };
    expect(JSON.parse(a1.p)).toBe("好的我来做");
    // 那个 5 万字的 tool output 绝不能进来 —— 真库里 tool part 有 166.29 MB。
    expect(a1.p).not.toContain("XXXX");
    expect(a1.p.length).toBeLessThan(200);
    db.close();
  });
});

describe("opencode 逐消息 token 事件", () => {
  it("事件人口是**全部**有 token 的 assistant 轮，与正文侧的人口不同", () => {
    const db = run();
    const events = db
      .prepare("SELECT message_id AS m FROM opencode_token_usage_event ORDER BY m")
      .all() as { m: string }[];
    // a1(有正文) 与 a2(无正文) 都有 token → 都进事件表
    expect(events.map((e) => e.m)).toEqual(["a1", "a2"]);

    const bodies = db
      .prepare("SELECT source_message_key AS k FROM agent_user_messages WHERE source='opencode' AND role='assistant' ORDER BY k")
      .all() as { k: string }[];
    // 正文侧是 a1、a3 —— 与事件侧只有 a1 重合。两个人口不是一个数。
    expect(bodies.map((b) => b.k)).toEqual(["a1", "a3"]);
    db.close();
  });

  it("五个原子分量逐个落位，不存任何可派生的量", () => {
    const db = run();
    const e = db
      .prepare(
        `SELECT fresh_input AS fi, cache_read_input AS cr, cache_creation_input AS cc,
                output AS o, reasoning_output AS ro
         FROM opencode_token_usage_event WHERE message_id='a1'`
      )
      .get() as Record<string, number>;
    expect(e).toEqual({ fi: 100, cr: 900, cc: 143, o: 20, ro: 7 });

    // 表里没有任何融合列 —— input_tokens 那个名字在本仓库承载「融合」语义。
    const cols = (
      db.prepare("PRAGMA table_info(opencode_token_usage_event)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).not.toContain("input_tokens");
    expect(cols).not.toContain("total_tokens");
    db.close();
  });

  it("重跑幂等：事件不重复、正文不重复", () => {
    const dir = makeDir();
    makeOpencodeDb(dir);
    const db = indexDb();
    ingestOpencodeUserMessages(db, { dataDir: dir });
    const before = {
      rows: (db.prepare("SELECT COUNT(*) n FROM agent_user_messages WHERE source='opencode'").get() as { n: number }).n,
      events: (db.prepare("SELECT COUNT(*) n FROM opencode_token_usage_event").get() as { n: number }).n,
    };
    // 水位会挡住第二遍,所以先把它清掉逼一次全量重扫。
    db.prepare("UPDATE agent_user_messages_sync_state SET watermark_ms=0 WHERE source='opencode'").run();
    ingestOpencodeUserMessages(db, { dataDir: dir });
    const after = {
      rows: (db.prepare("SELECT COUNT(*) n FROM agent_user_messages WHERE source='opencode'").get() as { n: number }).n,
      events: (db.prepare("SELECT COUNT(*) n FROM opencode_token_usage_event").get() as { n: number }).n,
    };
    expect(after).toEqual(before);
    db.close();
  });

  it("state 表写了 —— 趋势页 adapter 的 everPresent() 需要它", () => {
    const db = run();
    const st = db
      .prepare("SELECT rule_version AS rv, indexed_event_count AS n FROM opencode_token_usage_state WHERE id=1")
      .get() as { rv: number; n: number };
    expect(st.rv).toBe(1);
    expect(st.n).toBe(2);
    db.close();
  });
});
