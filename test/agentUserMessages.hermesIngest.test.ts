import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/store/migrations.js";
import { ingestHermesUserMessages } from "../src/agentUserMessages/hermesIngest.js";

/**
 * hermes → agent_user_messages 的口径回归。
 *
 * 关键在**三层回落**:assistant 的 cleaned_text 取 content → reasoning_content →
 * 工具调用摘要。真库里 725 条 assistant 有 434 条 content 为空,其中 225 条连
 * reasoning 也没有、却 100% 带工具调用。
 *
 * 「cleaned_text 非空」这一条**抓不到漏写第二层** —— 那些行会继续掉到第三层,
 * 仍然非空。所以每一层都要有一条专盯它「正文来自哪儿」的断言。
 *
 * fixture 全自造,不碰真实 home 路径,也不依赖本机装没装 hermes。
 */
describe("hermesIngest", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  type Msg = {
    id: number;
    session: string;
    role: string;
    content?: string | null;
    reasoning?: string | null;
    toolCalls?: unknown[] | null;
    toolCallId?: string | null;
    ts?: number;
  };

  /** 造一个最小但列齐的 hermes home。只建我们声明为 REQUIRED 的列。 */
  const makeHome = (
    sessions: { id: string; source?: string; title?: string | null }[],
    messages: Msg[],
    opts: { dropColumn?: string } = {}
  ) => {
    const home = mkdtempSync(join(tmpdir(), "hermes-"));
    dirs.push(home);
    mkdirSync(home, { recursive: true });
    const db = new Database(join(home, "state.db"));
    const sessionCols = [
      "id TEXT PRIMARY KEY",
      "source TEXT",
      "model TEXT",
      "started_at REAL",
      "ended_at REAL",
      "end_reason TEXT",
      "title TEXT",
      "message_count INTEGER",
      "tool_call_count INTEGER",
      "input_tokens INTEGER",
      "output_tokens INTEGER",
      "cache_read_tokens INTEGER",
    ].filter((c) => !opts.dropColumn || !c.startsWith(`${opts.dropColumn} `));
    db.exec(`CREATE TABLE sessions (${sessionCols.join(", ")})`);
    db.exec(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
      reasoning_content TEXT, tool_calls TEXT, tool_call_id TEXT, timestamp REAL)`);
    for (const s of sessions) {
      db.prepare(
        `INSERT INTO sessions (id, source, title, started_at, ended_at) VALUES (?,?,?,?,?)`
      ).run(s.id, s.source ?? "cli", s.title ?? "标题", 1700000000, 1700000100);
    }
    for (const m of messages) {
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, reasoning_content,
                               tool_calls, tool_call_id, timestamp)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(
        m.id,
        m.session,
        m.role,
        m.content ?? null,
        m.reasoning ?? null,
        m.toolCalls ? JSON.stringify(m.toolCalls) : null,
        m.toolCallId ?? null,
        m.ts ?? 1700000000 + m.id
      );
    }
    db.close();
    return home;
  };

  const fresh = () => {
    const db = new Database(":memory:");
    migrate(db);
    return db;
  };

  const call = (id: string, name: string, args: string) => ({
    id,
    function: { name, arguments: args },
  });

  const rowsOf = (db: Database.Database) =>
    db
      .prepare(
        `SELECT source_message_key AS k, role, cleaned_text AS text, char_len AS len,
                is_human AS human, project, raw_payload_json AS payload
           FROM agent_user_messages WHERE source='hermes'
          ORDER BY CAST(source_message_key AS INTEGER)`
      )
      .all() as {
      k: string;
      role: string;
      text: string;
      len: number;
      human: number;
      project: string | null;
      payload: string;
    }[];

  it("三层回落:content 优先", () => {
    const home = makeHome(
      [{ id: "s1" }],
      [
        { id: 1, session: "s1", role: "user", content: "问题" },
        {
          id: 2,
          session: "s1",
          role: "assistant",
          content: "回答正文",
          reasoning: "不该被选中的推理",
          toolCalls: [call("c1", "terminal", '{"command":"ls"}')],
        },
      ]
    );
    const db = fresh();
    expect(ingestHermesUserMessages(db, { hermesHome: home }).status).toBe("success");
    const rows = rowsOf(db);
    expect(rows.map((r) => r.text)).toEqual(["问题", "回答正文"]);
  });

  it("三层回落:content 空时取 reasoning,而不是掉到工具摘要", () => {
    const home = makeHome(
      [{ id: "s1" }],
      [
        { id: 1, session: "s1", role: "user", content: "问题" },
        {
          id: 2,
          session: "s1",
          role: "assistant",
          content: "",
          reasoning: "这是推理内容",
          // 带工具调用 —— 漏写第二层时会掉到这里,正文变成 "terminal: ..." 而**仍然非空**,
          // 所以只断言「非空」是抓不到的。
          toolCalls: [call("c1", "terminal", '{"command":"ls"}')],
        },
      ]
    );
    const db = fresh();
    ingestHermesUserMessages(db, { hermesHome: home });
    const asst = rowsOf(db).find((r) => r.role === "assistant")!;
    expect(asst.text).toBe("这是推理内容");
    expect(asst.text).not.toContain("terminal");
  });

  it("三层回落:content 与 reasoning 都空时,取工具调用摘要而不是留空", () => {
    const home = makeHome(
      [{ id: "s1" }],
      [
        { id: 1, session: "s1", role: "user", content: "问题" },
        {
          id: 2,
          session: "s1",
          role: "assistant",
          content: null,
          reasoning: null,
          toolCalls: [call("c1", "terminal", '{"command":"date"}')],
        },
      ]
    );
    const db = fresh();
    ingestHermesUserMessages(db, { hermesHome: home });
    const asst = rowsOf(db).find((r) => r.role === "assistant")!;
    expect(asst.text).toContain("terminal");
    expect(asst.len).toBeGreaterThan(0);
  });

  it("assistant 行的 cleaned_text 恒非空 —— 与现有四源同一条不变量", () => {
    const home = makeHome(
      [{ id: "s1" }],
      [
        { id: 1, session: "s1", role: "user", content: "问题" },
        { id: 2, session: "s1", role: "assistant", content: "有正文" },
        { id: 3, session: "s1", role: "assistant", content: "", reasoning: "有推理" },
        {
          id: 4,
          session: "s1",
          role: "assistant",
          toolCalls: [call("c1", "write_file", "{}")],
        },
      ]
    );
    const db = fresh();
    ingestHermesUserMessages(db, { hermesHome: home });
    const empties = rowsOf(db).filter((r) => r.role === "assistant" && r.len === 0);
    expect(empties).toEqual([]);
  });

  it("tool 行不产生 aum 行,而是折进宿主 assistant 的 payload", () => {
    const home = makeHome(
      [{ id: "s1" }],
      [
        { id: 1, session: "s1", role: "user", content: "问题" },
        {
          id: 2,
          session: "s1",
          role: "assistant",
          content: "调工具",
          toolCalls: [call("c1", "terminal", '{"command":"ls"}')],
        },
        { id: 3, session: "s1", role: "tool", content: "工具返回的一大段", toolCallId: "c1" },
      ]
    );
    const db = fresh();
    const r = ingestHermesUserMessages(db, { hermesHome: home });
    expect(r.upserted).toBe(2); // user + assistant,tool 不算
    const asst = rowsOf(db).find((r) => r.role === "assistant")!;
    const payload = JSON.parse(asst.payload) as { toolCalls: { result: string | null }[] };
    expect(payload.toolCalls[0]!.result).toBe("工具返回的一大段");
    // 工具结果**不进** cleaned_text —— 否则污染搜索页的 role='assistant' 筛子。
    expect(asst.text).not.toContain("工具返回的一大段");
  });

  it("session_meta 行被丢弃", () => {
    const home = makeHome(
      [{ id: "s1" }],
      [
        { id: 1, session: "s1", role: "user", content: "问题" },
        { id: 2, session: "s1", role: "session_meta", content: null },
      ]
    );
    const db = fresh();
    expect(ingestHermesUserMessages(db, { hermesHome: home }).upserted).toBe(1);
  });

  it("project 恒为 null —— hermes 没有项目归属,不发明伪 project_key", () => {
    const home = makeHome(
      [{ id: "s1" }],
      [{ id: 1, session: "s1", role: "user", content: "问题" }]
    );
    const db = fresh();
    ingestHermesUserMessages(db, { hermesHome: home });
    expect(rowsOf(db).every((r) => r.project === null)).toBe(true);
  });

  it("assistant 行带 answeringUserKey,指向同会话上一条 user", () => {
    const home = makeHome(
      [{ id: "s1" }],
      [
        { id: 1, session: "s1", role: "user", content: "第一问" },
        { id: 2, session: "s1", role: "assistant", content: "第一答" },
        { id: 3, session: "s1", role: "user", content: "第二问" },
        { id: 4, session: "s1", role: "assistant", content: "第二答" },
      ]
    );
    const db = fresh();
    ingestHermesUserMessages(db, { hermesHome: home });
    const got = db
      .prepare(
        `SELECT source_message_key AS k, answering_user_key AS a
           FROM agent_user_messages WHERE source='hermes' AND role='assistant'
          ORDER BY CAST(source_message_key AS INTEGER)`
      )
      .all() as { k: string; a: string | null }[];
    expect(got).toEqual([
      { k: "2", a: "1" },
      { k: "4", a: "3" },
    ]);
  });

  it("幂等:连跑两次行数不变", () => {
    const home = makeHome(
      [{ id: "s1" }],
      [
        { id: 1, session: "s1", role: "user", content: "问题" },
        { id: 2, session: "s1", role: "assistant", content: "回答" },
      ]
    );
    const db = fresh();
    const a = ingestHermesUserMessages(db, { hermesHome: home });
    const b = ingestHermesUserMessages(db, { hermesHome: home });
    expect(b.upserted).toBe(a.upserted);
    expect(rowsOf(db)).toHaveLength(2);
  });

  it("缺必备列 → schema-incompatible,不崩,且没写进任何行", () => {
    const home = makeHome(
      [{ id: "s1" }],
      [{ id: 1, session: "s1", role: "user", content: "问题" }],
      { dropColumn: "cache_read_tokens" }
    );
    const db = fresh();
    const r = ingestHermesUserMessages(db, { hermesHome: home });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("cache_read_tokens");
    expect(rowsOf(db)).toEqual([]);
  });

  it("hermes 没装 → skipped,不报错", () => {
    const home = mkdtempSync(join(tmpdir(), "hermes-none-"));
    dirs.push(home);
    const db = fresh();
    expect(ingestHermesUserMessages(db, { hermesHome: home }).status).toBe("skipped");
  });

  it("FTS 与主表同步 —— 搜得到工具摘要那一层", () => {
    const home = makeHome(
      [{ id: "s1" }],
      [
        { id: 1, session: "s1", role: "user", content: "问题" },
        {
          id: 2,
          session: "s1",
          role: "assistant",
          toolCalls: [call("c1", "arxivsearch", '{"q":"transformer"}')],
        },
      ]
    );
    const db = fresh();
    ingestHermesUserMessages(db, { hermesHome: home });
    const hit = db
      .prepare(
        `SELECT COUNT(*) n FROM agent_user_messages_fts
          WHERE agent_user_messages_fts MATCH 'arxivsearch'`
      )
      .get() as { n: number };
    expect(hit.n).toBe(1);
  });
});
