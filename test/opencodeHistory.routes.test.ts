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
