import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { listCodexProjects } from "../src/codexHistory/index.js";

type Row = { id: string; cwd: string; archived?: number; updatedAtMs?: number };

function makeRoot(): string {
  const root = join(
    tmpdir(),
    `ai2nao-codex-proj-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  mkdirSync(join(root, "sessions"), { recursive: true });
  return root;
}

function createStateDb(root: string, rows: Row[]): void {
  const db = new Database(join(root, "state_5.sqlite"));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      git_branch TEXT,
      first_user_message TEXT NOT NULL DEFAULT '',
      model TEXT,
      created_at_ms INTEGER,
      updated_at_ms INTEGER
    );
  `);
  const stmt = db.prepare(`
    INSERT INTO threads (id, rollout_path, created_at, updated_at, cwd, title,
      archived, git_branch, first_user_message, model, created_at_ms, updated_at_ms)
    VALUES (?, '/x.jsonl', 1, 2, ?, 't', ?, 'main', 'q', 'gpt-5', 1000, ?)
  `);
  for (const r of rows) {
    stmt.run(r.id, r.cwd, r.archived ?? 0, r.updatedAtMs ?? 2000);
  }
  db.close();
}

const T = (s: string) => Date.parse(s);

describe("listCodexProjects — 按 cwd 聚合项目", () => {
  it("按 cwd 分组,sessionCount + lastActiveAt=max,lastActive DESC 排序", async () => {
    const root = makeRoot();
    createStateDb(root, [
      { id: "a1", cwd: "/work/app", updatedAtMs: T("2026-06-01T00:00:00Z") },
      { id: "a2", cwd: "/work/app", updatedAtMs: T("2026-06-10T00:00:00Z") },
      { id: "a3", cwd: "/work/app", updatedAtMs: T("2026-06-05T00:00:00Z") },
      { id: "b1", cwd: "/work/lib", updatedAtMs: T("2026-06-20T00:00:00Z") },
    ]);

    const res = await listCodexProjects(root, { archived: false });
    expect(res.source).toBe("sqlite");
    expect(res.projects.map((p) => [p.path, p.sessionCount])).toEqual([
      ["/work/lib", 1], // lastActive 06-20 最新 → 排最前
      ["/work/app", 3],
    ]);
    const app = res.projects.find((p) => p.path === "/work/app")!;
    expect(app.name).toBe("app");
    expect(app.lastActiveAt).toBe(new Date(T("2026-06-10T00:00:00Z")).toISOString());
  });

  it("尾斜杠归一化:/x 与 /x/ 合并为一个项目(D2/D3)", async () => {
    const root = makeRoot();
    createStateDb(root, [
      { id: "a1", cwd: "/work/app" },
      { id: "a2", cwd: "/work/app/" },
    ]);
    const res = await listCodexProjects(root, { archived: false });
    expect(res.projects).toHaveLength(1);
    expect(res.projects[0].path).toBe("/work/app");
    expect(res.projects[0].sessionCount).toBe(2);
  });

  it("archived=include(D4):关→只未归档;开→已归档+未归档全计入", async () => {
    const root = makeRoot();
    createStateDb(root, [
      { id: "a1", cwd: "/work/app", archived: 0 },
      { id: "a2", cwd: "/work/app", archived: 1 },
      { id: "z1", cwd: "/work/zzz", archived: 1 }, // 整项目已归档
    ]);

    const off = await listCodexProjects(root, { archived: false });
    expect(off.projects.map((p) => [p.path, p.sessionCount])).toEqual([
      ["/work/app", 1], // 只数未归档;/work/zzz 整项目归档 → 不出现
    ]);

    const on = await listCodexProjects(root, { archived: true });
    const m = Object.fromEntries(on.projects.map((p) => [p.path, p.sessionCount]));
    expect(m["/work/app"]).toBe(2); // 已+未归档全计
    expect(m["/work/zzz"]).toBe(1); // 归档项目此时出现
  });

  it("空/whitespace cwd → 「(未知项目)」桶,id 为空", async () => {
    const root = makeRoot();
    createStateDb(root, [
      { id: "a1", cwd: "/work/app" },
      { id: "u1", cwd: "" },
      { id: "u2", cwd: "   " },
    ]);
    const res = await listCodexProjects(root, { archived: false });
    const unknown = res.projects.find((p) => p.name === "(未知项目)");
    expect(unknown).toBeDefined();
    expect(unknown!.id).toBe("");
    expect(unknown!.sessionCount).toBe(2);
  });

  it("空库 → 空项目列表", async () => {
    const root = makeRoot();
    createStateDb(root, []);
    const res = await listCodexProjects(root, { archived: false });
    expect(res.source).toBe("sqlite");
    expect(res.projects).toEqual([]);
  });

  it("state DB 缺失 → fallback(source=fallback,有诊断)", async () => {
    const root = makeRoot(); // 只建了 sessions/ 目录,无 state_5.sqlite
    const res = await listCodexProjects(root, { archived: false });
    expect(res.source).toBe("fallback");
    expect(res.diagnostics.some((d) => d.kind === "state-db-unavailable")).toBe(true);
  });
});
