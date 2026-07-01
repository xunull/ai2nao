import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { openDatabase, openReadOnlyDatabase } from "../src/store/open.js";

const T0 = Date.parse("2026-05-01T00:00:00.000Z");

function makeOpencodeDir(opts?: { brokenSchema?: boolean }): string {
  const dir = join(tmpdir(), `ai2nao-opencode-api-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "opencode.db"));
  if (opts?.brokenSchema) {
    db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT);`); // 缺 worktree + 其它表
    db.close();
    return dir;
  }
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER, cost REAL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER, data TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO project VALUES (?,?,?,?,?)").run("p1", "/work/app", "app", T0, T0 + 9000);
  db.prepare("INSERT INTO session (id,project_id,directory,title,model,agent,time_created,time_updated,time_archived,tokens_input,tokens_output,cost) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "s1", "p1", "/work/app", "加个功能", JSON.stringify({ id: "MiniMax-M3" }), "build", T0, T0 + 9000, null, 10, 5, 0.001
  );
  db.prepare("INSERT INTO message (id,session_id,time_created,data) VALUES (?,?,?,?)").run("m1", "s1", T0 + 100, JSON.stringify({ role: "user", time: { created: T0 + 100 } }));
  db.prepare("INSERT INTO part (id,message_id,session_id,time_created,data) VALUES (?,?,?,?,?)").run("pt1", "m1", "s1", T0 + 100, JSON.stringify({ type: "text", text: "帮我加个功能" }));
  db.close();
  return dir;
}

function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const idxDir = join(tmpdir(), `ai2nao-idx-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(idxDir, { recursive: true });
  const dbPath = join(idxDir, "idx.db");
  openDatabase(dbPath).close();
  const db = openReadOnlyDatabase(dbPath);
  return fn(createApp({ db })).finally(() => db.close());
}

describe("opencode history API", () => {
  it("GET /status 返回 dbPath", async () => {
    const dir = makeOpencodeDir();
    await withApp(async (app) => {
      const res = await app.request(`http://x/api/opencode-history/status?opencodeRoot=${encodeURIComponent(dir)}`);
      expect(res.status).toBe(200);
      const j = (await res.json()) as { dbPath: string };
      expect(j.dbPath).toContain("opencode.db");
    });
  });

  it("GET /projects 与 /sessions 与详情贯通", async () => {
    const dir = makeOpencodeDir();
    const enc = encodeURIComponent(dir);
    await withApp(async (app) => {
      const projs = (await (await app.request(`http://x/api/opencode-history/projects?opencodeRoot=${enc}`)).json()) as {
        source: string;
        projects: { id: string; sessionCount: number }[];
      };
      expect(projs.source).toBe("sqlite");
      expect(projs.projects[0].id).toBe("p1");

      const sess = (await (await app.request(`http://x/api/opencode-history/sessions?opencodeRoot=${enc}&projectId=p1`)).json()) as {
        sessions: { id: string }[];
      };
      expect(sess.sessions.map((s) => s.id)).toEqual(["s1"]);

      const detail = (await (await app.request(`http://x/api/opencode-history/sessions/s1?opencodeRoot=${enc}`)).json()) as {
        ok: boolean;
        session: { messages: { content: string }[] };
      };
      expect(detail.ok).toBe(true);
      expect(detail.session.messages[0].content).toBe("帮我加个功能");
    });
  });

  it("详情找不到 → 404", async () => {
    const dir = makeOpencodeDir();
    await withApp(async (app) => {
      const res = await app.request(`http://x/api/opencode-history/sessions/nope?opencodeRoot=${encodeURIComponent(dir)}`);
      expect(res.status).toBe(404);
    });
  });

  it("GET /my-messages 服务端清洗:结构注入丢 + mode 剥,只回真人手打", async () => {
    const dir = join(tmpdir(), `ai2nao-opencode-mymsg-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "opencode.db"));
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER, data TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO project VALUES (?,?,?,?,?)").run("p1", "/work/app", "app", T0, T0 + 9000);
    db.prepare("INSERT INTO session (id,project_id,directory,title,time_created,time_updated,time_archived) VALUES (?,?,?,?,?,?,?)").run("s1", "p1", "/work/app", "t", T0, T0 + 9000, null);
    const msg = db.prepare("INSERT INTO message (id,session_id,time_created,data) VALUES (?,?,?,?)");
    const part = db.prepare("INSERT INTO part (id,message_id,session_id,time_created,data) VALUES (?,?,?,?,?)");
    // m1: mode 注入 + 真实内容(同一 part)。m2: assistant(忽略)。m3: synthetic 注入(整条丢)。
    msg.run("m1", "s1", T0 + 100, JSON.stringify({ role: "user", time: { created: T0 + 100 } }));
    part.run("pt1", "m1", "s1", T0 + 100, JSON.stringify({ type: "text", text: "[search-mode]\nx\n---\nMANDATORY delegate_task z\n---\n真人问题" }));
    msg.run("m2", "s1", T0 + 200, JSON.stringify({ role: "assistant", time: { created: T0 + 200 } }));
    part.run("pt2", "m2", "s1", T0 + 200, JSON.stringify({ type: "text", text: "assistant 回复" }));
    msg.run("m3", "s1", T0 + 300, JSON.stringify({ role: "user", time: { created: T0 + 300 } }));
    part.run("pt3", "m3", "s1", T0 + 300, JSON.stringify({ type: "text", text: "Note: user opened file", synthetic: true }));
    db.close();

    await withApp(async (app) => {
      const res = await app.request(`http://x/api/opencode-history/sessions/s1/my-messages?opencodeRoot=${encodeURIComponent(dir)}`);
      expect(res.status).toBe(200);
      const j = (await res.json()) as { ok: boolean; messages: { text: string }[] };
      // m1 剥出真人问题;m2 是 assistant 忽略;m3 synthetic 整条丢 → 只剩 1 条。
      expect(j.messages.map((m) => m.text)).toEqual(["真人问题"]);
    });
  });

  it("GET /my-messages 找不到 session → 404", async () => {
    const dir = makeOpencodeDir();
    await withApp(async (app) => {
      const res = await app.request(`http://x/api/opencode-history/sessions/nope/my-messages?opencodeRoot=${encodeURIComponent(dir)}`);
      expect(res.status).toBe(404);
    });
  });

  it("schema 坏 → /projects 仍 200 + 诊断(错误隔离,不 500 整站)", async () => {
    const dir = makeOpencodeDir({ brokenSchema: true });
    await withApp(async (app) => {
      const res = await app.request(`http://x/api/opencode-history/projects?opencodeRoot=${encodeURIComponent(dir)}`);
      expect(res.status).toBe(200);
      const j = (await res.json()) as { projects: unknown[]; diagnostics: { kind: string }[] };
      expect(j.projects).toEqual([]);
      expect(j.diagnostics[0].kind).toBe("schema-incompatible");
    });
  });
});
