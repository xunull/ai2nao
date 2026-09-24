import BetterSqlite from "better-sqlite3";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ingestCherryUserMessages } from "../src/agentUserMessages/cherryIngest.js";
import { openDatabase } from "../src/store/open.js";

/**
 * cherry → agent_user_messages。
 *
 * 最要紧的三条:
 *  1. `root` 行不入库(每个 topic 一条树根,没有正文)
 *  2. 取的是**激活路径** —— 重新生成过的回答只算当前那条,否则同一个问题会入库两个答案
 *  3. `reasoning` 不进 cleaned_text,只进 payload(与 kimi 的 think 同口径)
 *
 * 加源的完整清单在 docs/agent-source-checklist.md —— 它开头就说
 * 「tsc 不会告诉你」,所以那些硬编码字面量数组靠 grep 核对,不靠这个文件。
 */

const T0 = Date.parse("2026-09-01T09:00:00Z");

function textPart(text: string): string {
  return JSON.stringify({ parts: [{ type: "text", text, state: "done" }] });
}

type Msg = { id: string; parent: string | null; role: string; text?: string; data?: string; at?: number };

/** 在 <root>/Data/cherrystudio.sqlite 造一个最小但真形状的库。 */
function seedCherryRoot(topics: { id: string; name: string; active: string; messages: Msg[] }[]): string {
  const root = mkdtempSync(join(tmpdir(), "ai2nao-cherry-ingest-"));
  mkdirSync(join(root, "Data"), { recursive: true });
  const db = new BetterSqlite(join(root, "Data", "cherrystudio.sqlite"));
  db.exec(`
    CREATE TABLE assistant (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE user_model (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE topic (
      id TEXT PRIMARY KEY, name TEXT DEFAULT '' NOT NULL, assistant_id TEXT,
      active_node_id TEXT, last_activity_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, parent_id TEXT, topic_id TEXT NOT NULL, role TEXT NOT NULL,
      data TEXT NOT NULL, searchable_text TEXT DEFAULT '' NOT NULL,
      siblings_group_id INTEGER DEFAULT 0 NOT NULL, model_id TEXT, fts_rowid INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE VIRTUAL TABLE message_fts USING fts5(
      searchable_text, content='message', content_rowid='fts_rowid', tokenize='trigram'
    );
    INSERT INTO assistant (id, name) VALUES ('a1', '运维工程师');
  `);
  let rowid = 0;
  for (const t of topics) {
    db.prepare(
      `INSERT INTO topic (id, name, assistant_id, active_node_id, last_activity_at, created_at, updated_at)
       VALUES (?, ?, 'a1', ?, ?, ?, ?)`
    ).run(t.id, t.name, t.active, T0 + 10_000, T0, T0);
    for (const m of t.messages) {
      rowid += 1;
      db.prepare(
        `INSERT INTO message (id, parent_id, topic_id, role, data, searchable_text,
                              fts_rowid, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        m.id, m.parent, t.id, m.role,
        m.data ?? textPart(m.text ?? ""),
        m.role === "root" ? "" : (m.text ?? ""),
        rowid, m.at ?? T0, m.at ?? T0
      );
    }
  }
  db.close();
  return root;
}

function freshIndex(): Database.Database {
  return openDatabase(join(mkdtempSync(join(tmpdir(), "ai2nao-cherry-idx-")), "index.db"));
}

const straight = () => ({
  id: "t1",
  name: "查看进程端口",
  active: "a-1",
  messages: [
    { id: "r-1", parent: null, role: "root", text: "" },
    { id: "u-1", parent: "r-1", role: "user", text: "mac如何查看端口占用", at: T0 + 1000 },
    { id: "a-1", parent: "u-1", role: "assistant", text: "用 lsof -p 看", at: T0 + 2000 },
  ] as Msg[],
});

const rows = (db: Database.Database) =>
  db
    .prepare(
      `SELECT source_session_id, source_message_key, role, is_human, cleaned_text, project,
              raw_payload_json, answering_user_key
       FROM agent_user_messages WHERE source = 'cherry' ORDER BY event_at_utc, id`
    )
    .all() as Record<string, unknown>[];

describe("cherry 入库", () => {
  it("跳过 root,一问一答各入一行", () => {
    const db = freshIndex();
    const r = ingestCherryUserMessages(db, { cherryRoot: seedCherryRoot([straight()]) });
    expect(r.status).toBe("success");
    expect(r.scannedTopics).toBe(1);

    const got = rows(db);
    expect(got.map((x) => x.role)).toEqual(["user", "assistant"]);
    expect(got.map((x) => x.is_human)).toEqual([1, 0]);
    expect(got[0]!.cleaned_text).toBe("mac如何查看端口占用");
    // assistant 行带着它在回答的那条提问 —— 搜索命中 AI 的话时靠它带出上下文
    expect(got[1]!.answering_user_key).toBe("u-1");
    db.close();
  });

  it("project 恒为 null,助手名进 payload", () => {
    const db = freshIndex();
    ingestCherryUserMessages(db, { cherryRoot: seedCherryRoot([straight()]) });
    const got = rows(db);
    expect(got.every((x) => x.project === null)).toBe(true);
    expect(JSON.parse(String(got[0]!.raw_payload_json)).assistant).toBe("运维工程师");
    db.close();
  });

  it("重新生成过的会话只入激活的那一条 —— 不是两个答案都入", () => {
    const db = freshIndex();
    ingestCherryUserMessages(db, {
      cherryRoot: seedCherryRoot([
        {
          id: "t1",
          name: "重生成",
          active: "a-新",
          messages: [
            { id: "r-1", parent: null, role: "root", text: "" },
            { id: "u-1", parent: "r-1", role: "user", text: "问题", at: T0 + 1000 },
            { id: "a-旧", parent: "u-1", role: "assistant", text: "旧回答", at: T0 + 2000 },
            { id: "a-新", parent: "u-1", role: "assistant", text: "新回答", at: T0 + 3000 },
          ],
        },
      ]),
    });
    expect(rows(db).map((x) => x.cleaned_text)).toEqual(["问题", "新回答"]);
    db.close();
  });

  it("reasoning 不进正文,只进 payload", () => {
    const db = freshIndex();
    const data = JSON.stringify({
      parts: [
        { type: "reasoning", text: "先想一下" },
        { type: "text", text: "可见的回答", state: "done" },
      ],
    });
    ingestCherryUserMessages(db, {
      cherryRoot: seedCherryRoot([
        {
          id: "t1",
          name: "带思考",
          active: "a-1",
          messages: [
            { id: "r-1", parent: null, role: "root", text: "" },
            { id: "u-1", parent: "r-1", role: "user", text: "问题", at: T0 + 1000 },
            { id: "a-1", parent: "u-1", role: "assistant", text: "可见的回答", data, at: T0 + 2000 },
          ],
        },
      ]),
    });
    const [, answer] = rows(db);
    expect(answer!.cleaned_text).toBe("可见的回答");
    expect(JSON.parse(String(answer!.raw_payload_json)).reasoning).toBe("先想一下");
    db.close();
  });

  it("重跑一次不产生重复行（自然键稳定）", () => {
    const db = freshIndex();
    const root = seedCherryRoot([straight()]);
    ingestCherryUserMessages(db, { cherryRoot: root });
    ingestCherryUserMessages(db, { cherryRoot: root });
    expect(rows(db)).toHaveLength(2);
    db.close();
  });

  it("没装 Cherry（或还是 2.0.14 之前）→ skipped,不是 failed", () => {
    const db = freshIndex();
    const r = ingestCherryUserMessages(db, {
      cherryRoot: mkdtempSync(join(tmpdir(), "ai2nao-cherry-none-")),
    });
    expect(r.status).toBe("skipped");
    expect(rows(db)).toHaveLength(0);
    db.close();
  });
});
