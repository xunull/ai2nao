import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  listOpencodeProjects,
  listOpencodeSessionSummaries,
  loadOpencodeSessionDetail,
} from "../src/opencodeHistory/index.js";

function makeDir(): string {
  const dir = join(tmpdir(), `ai2nao-opencode-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const T0 = Date.parse("2026-05-01T00:00:00.000Z");

/** 建一个最小但贴合真实 schema 的 opencode.db。 */
function makeDb(dir: string, opts?: { dropPartData?: boolean }): void {
  const db = new Database(join(dir, "opencode.db"));
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
      model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
      tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, cost REAL DEFAULT 0
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, data ${opts?.dropPartData ? "TEXT" : "TEXT NOT NULL"});
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER, data TEXT NOT NULL);
  `);

  db.prepare("INSERT INTO project VALUES (?,?,?,?,?)").run("p1", "/work/app", "app", T0, T0 + 9000);
  db.prepare("INSERT INTO project VALUES (?,?,?,?,?)").run("p2", "/work/lib", null, T0, T0 + 1000);

  const sess = db.prepare(
    "INSERT INTO session (id,project_id,directory,title,model,agent,time_created,time_updated,time_archived,tokens_input,tokens_output,cost) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  sess.run("s1", "p1", "/work/app", "加个功能", JSON.stringify({ id: "MiniMax-M3", providerID: "minimax" }), "build", T0, T0 + 9000, null, 1200, 340, 0.012);
  sess.run("s2", "p1", "/work/app", "已归档会话", null, null, T0, T0 + 5000, T0 + 6000, 0, 0, 0); // archived
  sess.run("s3", "p2", "/work/lib", "lib 会话", null, null, T0, T0 + 1000, null, 0, 0, 0);

  const msg = db.prepare("INSERT INTO message (id,session_id,time_created,data) VALUES (?,?,?,?)");
  const part = db.prepare("INSERT INTO part (id,message_id,session_id,time_created,data) VALUES (?,?,?,?,?)");

  // s1: m1 user(1 text)；m2 assistant(reasoning + text + tool)；m3 assistant(只 step → 空，应跳过)
  msg.run("m1", "s1", T0 + 100, JSON.stringify({ role: "user", time: { created: T0 + 100 } }));
  part.run("pt1", "m1", "s1", T0 + 100, JSON.stringify({ type: "text", text: "帮我加个功能" }));

  msg.run("m2", "s1", T0 + 200, JSON.stringify({ role: "assistant", time: { created: T0 + 200 }, model: { id: "MiniMax-M3" } }));
  part.run("pt2a", "m2", "s1", T0 + 200, JSON.stringify({ type: "reasoning", text: "先看代码结构" }));
  part.run("pt2b", "m2", "s1", T0 + 201, JSON.stringify({ type: "text", text: "好的我来做" }));
  part.run("pt2c", "m2", "s1", T0 + 202, JSON.stringify({ type: "tool", tool: "read", state: { status: "completed", input: { path: "a.ts" }, output: "文件内容" } }));

  msg.run("m3", "s1", T0 + 300, JSON.stringify({ role: "assistant", time: { created: T0 + 300 } }));
  part.run("pt3a", "m3", "s1", T0 + 300, JSON.stringify({ type: "step-start" }));
  part.run("pt3b", "m3", "s1", T0 + 301, JSON.stringify({ type: "step-finish" }));

  db.close();
}

describe("opencodeHistory", () => {
  it("按 project.id 分组、统计会话数、默认隐藏归档", async () => {
    const dir = makeDir();
    makeDb(dir);
    const res = await listOpencodeProjects(dir, { archived: false });
    expect(res.diagnostics).toEqual([]);
    const byId = Object.fromEntries(res.projects.map((p) => [p.id, p]));
    // p1 有 2 个 session 但 s2 归档 → 默认计 1；p2 计 1。
    expect(byId.p1.sessionCount).toBe(1);
    expect(byId.p1.name).toBe("app");
    expect(byId.p2.name).toBe("lib"); // name 为 null → basename(worktree)
    // 含归档 → p1 计 2。
    const all = await listOpencodeProjects(dir, { archived: true });
    expect(Object.fromEntries(all.projects.map((p) => [p.id, p])).p1.sessionCount).toBe(2);
  });

  it("列表按 projectId 过滤、归档过滤、带 opencode 元数据(model/tokens)", async () => {
    const dir = makeDir();
    makeDb(dir);
    const res = await listOpencodeSessionSummaries(dir, { projectId: "p1", archived: false });
    expect(res.sessions.map((s) => s.id)).toEqual(["s1"]); // s2 归档隐藏
    const oc = (res.sessions[0].metadata as { opencode?: Record<string, unknown> }).opencode!;
    expect(oc.model).toBe("MiniMax-M3"); // 从 JSON 解析出 id
    expect(oc.tokensInput).toBe(1200);
    expect(oc.tokensOutput).toBe(340);
    // 含归档 → s1 + s2。
    const all = await listOpencodeSessionSummaries(dir, { projectId: "p1", archived: true });
    expect(all.sessions.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("详情:message+part 拼接出 role+text，reasoning→thinking，tool→toolCalls，空 message 跳过", async () => {
    const dir = makeDir();
    makeDb(dir);
    const detail = await loadOpencodeSessionDetail(dir, "s1");
    const msgs = detail!.session.messages;
    // m3 只有 step part → 空 → 跳过；剩 m1, m2。
    expect(msgs.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("帮我加个功能");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("好的我来做");
    expect(msgs[1].thinking).toBe("先看代码结构");
    expect(msgs[1].toolCalls).toHaveLength(1);
    expect(msgs[1].toolCalls![0].name).toBe("read");
    expect(msgs[1].toolCalls![0].result).toBe("文件内容");
  });

  it("库不存在 → 空结果 + db-not-found 诊断(不崩、不影响其它源)", async () => {
    const dir = makeDir(); // 不建库
    const res = await listOpencodeProjects(dir, { archived: false });
    expect(res.projects).toEqual([]);
    expect(res.diagnostics[0].kind).toBe("db-not-found");
  });

  it("schema 缺列 → schema-incompatible 诊断而非抛错", async () => {
    const dir = makeDir();
    const db = new Database(join(dir, "opencode.db"));
    // project 缺 worktree 列。
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE session (id TEXT, project_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);
    db.close();
    const res = await listOpencodeProjects(dir, { archived: false });
    expect(res.projects).toEqual([]);
    expect(res.diagnostics[0].kind).toBe("schema-incompatible");
  });
});
