import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { openDatabase, openReadOnlyDatabase } from "../src/store/open.js";

function codexRootWithThreads(
  rows: { id: string; cwd: string; archived?: number }[]
): string {
  const root = join(tmpdir(), `ai2nao-codex-proj-api-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(root, "sessions"), { recursive: true });
  const db = new Database(join(root, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0, git_branch TEXT,
    first_user_message TEXT NOT NULL DEFAULT '', model TEXT,
    created_at_ms INTEGER, updated_at_ms INTEGER );`);
  const stmt = db.prepare(`INSERT INTO threads (id, rollout_path, created_at, updated_at, cwd, title, archived, git_branch, first_user_message, model, created_at_ms, updated_at_ms) VALUES (?, '/x.jsonl', 1, 2, ?, 't', ?, 'main', 'q', 'gpt-5', 1000, 2000)`);
  for (const r of rows) stmt.run(r.id, r.cwd, r.archived ?? 0);
  db.close();
  return root;
}

describe("Codex history API", () => {
  it("GET /projects 按 cwd 分组(只受 archived 影响,D1)", async () => {
    const codexRoot = codexRootWithThreads([
      { id: "a1", cwd: "/work/app" },
      { id: "a2", cwd: "/work/app/" }, // 尾斜杠 → 合并
      { id: "b1", cwd: "/work/lib" },
      { id: "z1", cwd: "/work/zzz", archived: 1 },
    ]);
    const dbPath = join(codexRoot, "idx.db");
    openDatabase(dbPath).close();
    const db = openReadOnlyDatabase(dbPath);
    try {
      const app = createApp({ db });
      const enc = encodeURIComponent(codexRoot);

      const res = await app.request(`http://x/api/codex-history/projects?codexRoot=${enc}`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { source: string; projects: { path: string; sessionCount: number }[] };
      expect(json.source).toBe("sqlite");
      const m = Object.fromEntries(json.projects.map((p) => [p.path, p.sessionCount]));
      expect(m["/work/app"]).toBe(2); // 尾斜杠合并
      expect(m["/work/lib"]).toBe(1);
      expect(m["/work/zzz"]).toBeUndefined(); // 归档项目默认隐藏

      const resAll = await app.request(`http://x/api/codex-history/projects?codexRoot=${enc}&archived=true`);
      const jsonAll = (await resAll.json()) as { projects: { path: string }[] };
      expect(jsonAll.projects.map((p) => p.path)).toContain("/work/zzz"); // include
    } finally {
      db.close();
    }
  });

  it("returns fallback diagnostics without transcript text", async () => {
    const base = join(tmpdir(), `ai2nao-codex-api-${Date.now()}`);
    const codexRoot = join(base, "codex");
    const sessions = join(codexRoot, "sessions", "2026", "04", "26");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "rollout-2026-04-26T00-00-00-ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-04-26T00:00:00.000Z",
        payload: { type: "user_message", message: "private transcript text" },
      }),
      "utf8"
    );

    const dbPath = join(base, "idx.db");
    const dbw = openDatabase(dbPath);
    dbw.close();
    const db = openReadOnlyDatabase(dbPath);
    try {
      const app = createApp({ db });
      const res = await app.request(
        `http://x/api/codex-history/sessions?codexRoot=${encodeURIComponent(codexRoot)}`
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        source: string;
        diagnostics: { kind: string; message: string }[];
        sessions: { preview: string }[];
      };
      expect(json.source).toBe("fallback");
      expect(json.diagnostics[0].kind).toBe("state-db-unavailable");
      expect(JSON.stringify(json.diagnostics)).not.toContain("private transcript text");
      expect(json.sessions[0].preview).toContain("private transcript text");
    } finally {
      db.close();
    }
  });
});
