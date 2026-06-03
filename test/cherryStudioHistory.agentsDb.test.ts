import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  listCherryAgentSessions,
  loadCherryAgentSession,
} from "../src/cherryStudioHistory/agentsDb.js";

function tempPath(name: string): string {
  const dir = join(tmpdir(), `ai2nao-cherry-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

function createAgentsDb(path: string) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      agent_type TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      accessible_paths TEXT,
      instructions TEXT,
      model TEXT NOT NULL,
      plan_model TEXT,
      small_model TEXT,
      mcps TEXT,
      allowed_tools TEXT,
      configuration TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE session_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      agent_session_id TEXT DEFAULT ''
    );
  `);
  db.prepare(`
    INSERT INTO sessions (id, agent_type, agent_id, name, description, model, created_at, updated_at)
    VALUES ('s1', 'openclaw', 'agent-a', 'Cherry task', 'Agent description', 'claude-sonnet', '2026-05-01T00:00:00.000Z', '2026-05-01T00:03:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO session_messages (session_id, role, content, metadata, created_at, updated_at, agent_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "s1",
    "user",
    "读取本地项目",
    "{bad json",
    "2026-05-01T00:01:00.000Z",
    "2026-05-01T00:01:00.000Z",
    "as1"
  );
  db.prepare(`
    INSERT INTO session_messages (session_id, role, content, metadata, created_at, updated_at, agent_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "s1",
    "assistant",
    JSON.stringify({ text: "已经完成 Cherry Studio 对话读取方案。" }),
    JSON.stringify({ ok: true }),
    "2026-05-01T00:02:00.000Z",
    "2026-05-01T00:02:00.000Z",
    "as1"
  );
  db.close();
}

describe("cherryStudioHistory agents.db", () => {
  it("lists and loads Cherry Studio agent sessions read-only", () => {
    const dbPath = tempPath("agents.db");
    createAgentsDb(dbPath);
    try {
      const listed = listCherryAgentSessions(dbPath);
      expect(listed.warnings).toEqual([]);
      expect(listed.sessions).toHaveLength(1);
      expect(listed.sessions[0]).toMatchObject({
        id: "agent:s1",
        title: "Cherry task",
        messageCount: 2,
        source: "cherry-studio",
      });

      const detail = loadCherryAgentSession(dbPath, "s1");
      expect(detail?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(detail?.messages[1].content).toBe("已经完成 Cherry Studio 对话读取方案。");
      expect(detail?.messages[0].metadata?.cherryMessageMetadata).toBeUndefined();
    } finally {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    }
  });

  it("returns a warning when agents.db is missing", () => {
    const result = listCherryAgentSessions(tempPath("missing.db"));
    expect(result.sessions).toEqual([]);
    expect(result.warnings[0]).toContain("agents.db not found");
  });
});
