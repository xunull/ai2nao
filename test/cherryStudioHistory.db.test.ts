import BetterSqlite from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activePath,
  listTopics,
  loadTopic,
  partsOf,
  searchMessages,
  usesFts,
} from "../src/cherryStudioHistory/db.js";

/**
 * Cherry Studio 2.0.14 的 `Data/cherrystudio.sqlite`。
 *
 * schema 是从真库 `.schema` 抄的**子集**:只留这段代码真正读的列与约束。
 * 抄全了反而会掩盖问题 —— 真库有 60 张表,这里读 4 张。
 *
 * 两件事最要紧:
 *  1. 取正文要沿 `active_node_id` 回溯,不能按 created_at 平铺 ——
 *     后者会把重新生成前后的两个回答都列出来(真库当前 0 个分支,平铺看不出错)。
 *  2. trigram 的中文查询**三个字起**,不足要回退 LIKE。
 */

const SCHEMA = `
  CREATE TABLE assistant (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE user_model (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE topic (
    id TEXT PRIMARY KEY,
    name TEXT DEFAULT '' NOT NULL,
    assistant_id TEXT,
    active_node_id TEXT,
    last_activity_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE TABLE message (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    topic_id TEXT NOT NULL,
    role TEXT NOT NULL,
    data TEXT NOT NULL,
    searchable_text TEXT DEFAULT '' NOT NULL,
    siblings_group_id INTEGER DEFAULT 0 NOT NULL,
    model_id TEXT,
    fts_rowid INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE VIRTUAL TABLE message_fts USING fts5(
    searchable_text, content='message', content_rowid='fts_rowid', tokenize='trigram'
  );
`;

const T0 = Date.parse("2026-09-01T09:00:00Z");
let rowid = 0;

function textPart(text: string): string {
  return JSON.stringify({ parts: [{ type: "text", text, state: "done" }] });
}

function withReasoning(text: string, reasoning: string): string {
  return JSON.stringify({
    parts: [
      { type: "reasoning", text: reasoning },
      { type: "text", text, state: "done" },
    ],
  });
}

type Msg = {
  id: string;
  parent: string | null;
  role: string;
  data?: string;
  text?: string;
  at?: number;
  deleted?: boolean;
  model?: string | null;
};

function makeDb(topics: { id: string; name: string; active: string; messages: Msg[]; deleted?: boolean }[]) {
  const db = new BetterSqlite(join(mkdtempSync(join(tmpdir(), "ai2nao-cherry-")), "cherrystudio.sqlite"));
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO assistant (id, name) VALUES ('a1', '默认助手')`).run();
  db.prepare(`INSERT INTO user_model (id, name) VALUES ('m1', 'kimi-k3')`).run();

  for (const t of topics) {
    db.prepare(
      `INSERT INTO topic (id, name, assistant_id, active_node_id, last_activity_at, created_at, updated_at, deleted_at)
       VALUES (?, ?, 'a1', ?, ?, ?, ?, ?)`
    ).run(t.id, t.name, t.active, T0 + 10_000, T0, T0, t.deleted ? T0 : null);

    for (const m of t.messages) {
      rowid += 1;
      const data = m.data ?? textPart(m.text ?? "");
      const searchable = m.role === "root" ? "" : (m.text ?? "");
      db.prepare(
        `INSERT INTO message (id, parent_id, topic_id, role, data, searchable_text, model_id,
                              fts_rowid, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        m.id, m.parent, t.id, m.role, data, searchable, m.model ?? null,
        rowid, m.at ?? T0, m.at ?? T0, m.deleted ? T0 : null
      );
      if (searchable) {
        db.prepare(`INSERT INTO message_fts (rowid, searchable_text) VALUES (?, ?)`).run(rowid, searchable);
      }
    }
  }
  return db;
}

/** 一问一答的直链会话,是真库当前的形状(626 个 topic 全都没有分支)。 */
function straightTopic() {
  return {
    id: "t1",
    name: "查看进程端口",
    active: "a-1",
    messages: [
      { id: "r-1", parent: null, role: "root", text: "" },
      { id: "u-1", parent: "r-1", role: "user", text: "mac如何查看某个进程占用了哪些端口", at: T0 + 1000 },
      { id: "a-1", parent: "u-1", role: "assistant", text: "用 lsof -p 看", at: T0 + 2000, model: "m1" },
    ] as Msg[],
  };
}

describe("partsOf", () => {
  it("只把 text 收进正文,reasoning 单独出来", () => {
    expect(partsOf(withReasoning("答案", "先想一下"))).toEqual({ text: "答案", thinking: "先想一下" });
  });

  it("dynamic-tool 不进正文 —— 那是工具载荷,不是模型说的话", () => {
    const data = JSON.stringify({
      parts: [
        { type: "dynamic-tool", text: "tool payload" },
        { type: "text", text: "真正的回答" },
      ],
    });
    expect(partsOf(data)).toEqual({ text: "真正的回答", thinking: "" });
  });

  it("data-error 取 .data.message —— 它的值不在 .text 里", () => {
    // 真库里唯一的一条:用户点了停止。丢掉它那场对话就会出现「连问两次、中间没回答」。
    const data = JSON.stringify({
      parts: [{ type: "data-error", data: { name: "AbortError", message: "Request was aborted" } }],
    });
    expect(partsOf(data)).toEqual({ text: "Request was aborted", thinking: "" });
  });

  it("dynamic-tool 仍然不进正文 —— 放宽的只是 data-error 一类", () => {
    const data = JSON.stringify({
      parts: [{ type: "dynamic-tool", data: { message: "tool payload" }, text: "也不要" }],
    });
    expect(partsOf(data)).toEqual({ text: "", thinking: "" });
  });

  it("多段 text 按顺序拼起来", () => {
    const data = JSON.stringify({ parts: [{ type: "text", text: "一" }, { type: "text", text: "二" }] });
    expect(partsOf(data).text).toBe("一\n二");
  });

  it("坏 JSON 与缺 parts 都当空,不抛", () => {
    expect(partsOf("{不是 json")).toEqual({ text: "", thinking: "" });
    expect(partsOf("{}")).toEqual({ text: "", thinking: "" });
    expect(partsOf(JSON.stringify({ parts: "not-an-array" }))).toEqual({ text: "", thinking: "" });
  });
});

describe("activePath", () => {
  it("parent 指针成环时停下,不死循环", () => {
    const byId = new Map<string, never>([
      ["a", { id: "a", parent_id: "b" } as never],
      ["b", { id: "b", parent_id: "a" } as never],
    ]);
    expect(activePath(byId, "a").map((r) => (r as { id: string }).id)).toEqual(["b", "a"]);
  });

  it("active 指向一个不存在的 id 时返回空,不抛", () => {
    expect(activePath(new Map(), "没有这个")).toEqual([]);
  });
});

describe("listTopics", () => {
  it("给出标题、助手名、消息数与首句(root 不计数)", () => {
    const db = makeDb([straightTopic()]);
    const [s] = listTopics(db);
    expect(s).toMatchObject({
      id: "t1",
      title: "查看进程端口",
      workspacePath: "默认助手",
      messageCount: 2,
      source: "cherry-studio",
    });
    expect(s!.preview).toContain("mac如何查看");
    db.close();
  });

  it("软删除的 topic 不列出来", () => {
    const db = makeDb([{ ...straightTopic(), deleted: true }]);
    expect(listTopics(db)).toEqual([]);
    db.close();
  });
});

describe("loadTopic", () => {
  it("跳过 root 行,按时序给出一问一答,带模型名", () => {
    const db = makeDb([straightTopic()]);
    const session = loadTopic(db, "t1")!;
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1]!.model).toBe("kimi-k3");
    expect(session.messageCount).toBe(2);
    db.close();
  });

  it("重新生成过的会话只取激活的那一条,不是两个回答都列", () => {
    const db = makeDb([
      {
        id: "t1",
        name: "重生成",
        active: "a-新", // 指向新的那一条
        messages: [
          { id: "r-1", parent: null, role: "root", text: "" },
          { id: "u-1", parent: "r-1", role: "user", text: "问题", at: T0 + 1000 },
          { id: "a-旧", parent: "u-1", role: "assistant", text: "旧回答", at: T0 + 2000 },
          { id: "a-新", parent: "u-1", role: "assistant", text: "新回答", at: T0 + 3000 },
        ],
      },
    ]);
    const session = loadTopic(db, "t1")!;
    expect(session.messages.map((m) => m.content)).toEqual(["问题", "新回答"]);
    db.close();
  });

  it("reasoning 进 thinking,不进 content", () => {
    const db = makeDb([
      {
        id: "t1",
        name: "带思考",
        active: "a-1",
        messages: [
          { id: "r-1", parent: null, role: "root", text: "" },
          { id: "u-1", parent: "r-1", role: "user", text: "问题", at: T0 + 1000 },
          {
            id: "a-1", parent: "u-1", role: "assistant", at: T0 + 2000,
            data: withReasoning("可见的回答", "这是思考过程"), text: "可见的回答",
          },
        ],
      },
    ]);
    const [, answer] = loadTopic(db, "t1")!.messages;
    expect(answer!.content).toBe("可见的回答");
    expect(answer!.thinking).toBe("这是思考过程");
    db.close();
  });

  it("软删除的消息不出现在正文里", () => {
    const db = makeDb([
      {
        id: "t1",
        name: "删过一条",
        active: "a-1",
        messages: [
          { id: "r-1", parent: null, role: "root", text: "" },
          { id: "u-1", parent: "r-1", role: "user", text: "问题", at: T0 + 1000 },
          { id: "a-1", parent: "u-1", role: "assistant", text: "回答", at: T0 + 2000, deleted: true },
        ],
      },
    ]);
    // 激活叶子本身被删 → 回溯断在那里,只剩不到它的部分
    expect(loadTopic(db, "t1")!.messages.map((m) => m.content)).toEqual([]);
    db.close();
  });

  it("topic 不存在时返回 null", () => {
    const db = makeDb([straightTopic()]);
    expect(loadTopic(db, "没有这个")).toBeNull();
    db.close();
  });
});

describe("搜索", () => {
  it("三个字及以上走 FTS", () => {
    expect(usesFts("如何查看")).toBe(true);
    expect(usesFts("abc")).toBe(true);
  });

  it("中文两字走 LIKE —— trigram 对它恒空", () => {
    expect(usesFts("端口")).toBe(false);
    expect(usesFts("口")).toBe(false);
  });

  it("四字中文查询能命中", () => {
    const db = makeDb([straightTopic()]);
    const results = searchMessages(db, "如何查看", { limit: 10, contextChars: 20 });
    expect(results).toHaveLength(1);
    expect(results[0]!.sessionId).toBe("t1");
    expect(results[0]!.snippets[0]!.messageRole).toBe("user");
    db.close();
  });

  it("两字中文查询照样命中 —— 这条正是回退存在的理由", () => {
    const db = makeDb([straightTopic()]);
    expect(searchMessages(db, "端口", { limit: 10, contextChars: 20 })).toHaveLength(1);
    db.close();
  });

  it("matchPositions 指向截取后文本里的位置", () => {
    const db = makeDb([straightTopic()]);
    const snippet = searchMessages(db, "哪些端口", { limit: 10, contextChars: 5 })[0]!.snippets[0]!;
    const [start, end] = snippet.matchPositions[0]!;
    expect(snippet.text.slice(start, end)).toBe("哪些端口");
    db.close();
  });

  it("LIKE 的通配符按字面处理,不当模式", () => {
    const db = makeDb([
      {
        id: "t1", name: "百分号", active: "u-1",
        messages: [
          { id: "r-1", parent: null, role: "root", text: "" },
          { id: "u-1", parent: "r-1", role: "user", text: "进度 100% 完成", at: T0 + 1000 },
        ],
      },
    ]);
    expect(searchMessages(db, "0%", { limit: 10, contextChars: 20 })).toHaveLength(1);
    expect(searchMessages(db, "%x", { limit: 10, contextChars: 20 })).toHaveLength(0);
    db.close();
  });

  it("空查询返回空", () => {
    const db = makeDb([straightTopic()]);
    expect(searchMessages(db, "   ", { limit: 10, contextChars: 20 })).toEqual([]);
    db.close();
  });
});
