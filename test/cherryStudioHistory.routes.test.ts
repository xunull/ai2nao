import BetterSqlite from "better-sqlite3";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";

/**
 * 四个路由跑在一个最小的 `Data/cherrystudio.sqlite` 上(Cherry Studio 2.0.14 的格式)。
 *
 * 这个文件原本整套建在 Markdown 导出源上 —— 那条路径连同 IndexedDB、agents.db
 * 一起删了,见 docs/adr/0003-cherry-studio-sqlite.md。
 */

function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

const T0 = Date.parse("2026-09-01T09:00:00Z");

/** 在 <root>/Data/cherrystudio.sqlite 造两场会话。 */
function seedCherryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ai2nao-cherry-route-"));
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
    INSERT INTO assistant (id, name) VALUES ('a1', '默认助手');
  `);

  let rowid = 0;
  const addMessage = (
    topicId: string,
    id: string,
    parent: string | null,
    role: string,
    text: string,
    at: number
  ) => {
    rowid += 1;
    const data = JSON.stringify({ parts: [{ type: "text", text, state: "done" }] });
    const searchable = role === "root" ? "" : text;
    db.prepare(
      `INSERT INTO message (id, parent_id, topic_id, role, data, searchable_text,
                            fts_rowid, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, parent, topicId, role, data, searchable, rowid, at, at);
    if (searchable) {
      db.prepare(`INSERT INTO message_fts (rowid, searchable_text) VALUES (?, ?)`).run(rowid, searchable);
    }
  };

  const addTopic = (id: string, name: string, activity: number, question: string, answer: string) => {
    db.prepare(
      `INSERT INTO topic (id, name, assistant_id, active_node_id, last_activity_at, created_at, updated_at)
       VALUES (?, ?, 'a1', ?, ?, ?, ?)`
    ).run(id, name, `${id}-a`, activity, T0, T0);
    addMessage(id, `${id}-r`, null, "root", "", T0);
    addMessage(id, `${id}-u`, `${id}-r`, "user", question, T0 + 1000);
    addMessage(id, `${id}-a`, `${id}-u`, "assistant", answer, T0 + 2000);
  };

  addTopic("t-new", "Cherry 路由", T0 + 20_000, "hello cherry", "route search works");
  addTopic("t-old", "Older Cherry", T0 + 10_000, "older question", "older answer");
  db.close();
  return root;
}

describe("Cherry Studio history routes", () => {
  it("status / 列表 / 详情 / 搜索四条路由都走新的 sqlite", async () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), "ai2nao-cherry-idx-")), "index.db"));
    const root = seedCherryRoot();
    const app = createApp({ db });
    try {
      const query = qs({ cherryRoot: root });

      const status = await app.request(`http://x/api/cherry-studio-history/status?${query}`);
      expect(status.status).toBe(200);
      const statusJson = (await status.json()) as {
        dbPath: string;
        dbMissing: boolean;
        topicCount: number | null;
      };
      expect(statusJson.dbMissing).toBe(false);
      expect(statusJson.topicCount).toBe(2);
      expect(statusJson.dbPath.endsWith("cherrystudio.sqlite")).toBe(true);

      const list = await app.request(
        `http://x/api/cherry-studio-history/sessions?${query}&limit=50&offset=0`
      );
      const listJson = (await list.json()) as {
        total: number;
        limit: number;
        offset: number;
        sessions: Array<{ id: string; title: string; messageCount: number }>;
      };
      expect(listJson.total).toBe(2);
      // 按最后活动时间倒序 —— 新的那场在前
      expect(listJson.sessions[0]!.title).toBe("Cherry 路由");
      expect(listJson.sessions[0]!.messageCount).toBe(2); // root 不计

      const pageTwo = await app.request(
        `http://x/api/cherry-studio-history/sessions?${query}&limit=1&offset=1`
      );
      const pageTwoJson = (await pageTwo.json()) as {
        total: number;
        offset: number;
        sessions: Array<{ title: string }>;
      };
      expect(pageTwoJson.total).toBe(2);
      expect(pageTwoJson.offset).toBe(1);
      expect(pageTwoJson.sessions).toHaveLength(1);
      expect(pageTwoJson.sessions[0]!.title).toBe("Older Cherry");

      // 会话 id 就是 topic id,不带 `indexeddb:` 之类的前缀
      const detail = await app.request(`http://x/api/cherry-studio-history/sessions/t-new?${query}`);
      expect(detail.status).toBe(200);
      const detailJson = (await detail.json()) as { session: { messages: unknown[] } };
      expect(detailJson.session.messages).toHaveLength(2);

      const search = await app.request(
        `http://x/api/cherry-studio-history/search?${query}&q=${encodeURIComponent("route search")}`
      );
      const searchJson = (await search.json()) as { results: Array<{ sessionId: string }> };
      expect(searchJson.results).toHaveLength(1);
      expect(searchJson.results[0]!.sessionId).toBe("t-new");
    } finally {
      db.close();
    }
  });

  it("库不在时不报错,但要说清是版本问题", async () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), "ai2nao-cherry-idx-")), "index.db"));
    const emptyRoot = mkdtempSync(join(tmpdir(), "ai2nao-cherry-empty-"));
    const app = createApp({ db });
    try {
      const query = qs({ cherryRoot: emptyRoot });

      const status = await app.request(`http://x/api/cherry-studio-history/status?${query}`);
      const statusJson = (await status.json()) as { dbMissing: boolean; warnings?: string[] };
      expect(statusJson.dbMissing).toBe(true);
      expect(statusJson.warnings?.[0]).toContain("2.0.14");

      const list = await app.request(`http://x/api/cherry-studio-history/sessions?${query}`);
      expect(list.status).toBe(200);
      const listJson = (await list.json()) as {
        total: number;
        diagnostics: Array<{ kind: string }>;
      };
      expect(listJson.total).toBe(0);
      // 空列表要带原因 —— 静默空态正是这次改动要消灭的东西
      expect(listJson.diagnostics.map((d) => d.kind)).toContain("dbMissing");
    } finally {
      db.close();
    }
  });
});
