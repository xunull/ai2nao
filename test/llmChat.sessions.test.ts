import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";
import {
  createLlmChatSession,
  getLlmChatSession,
  listLlmChatSessions,
  syncLlmChatSession,
} from "../src/llmChat/sessions.js";

function freshDb() {
  return openDatabase(
    join(tmpdir(), `ai2nao-llm-chat-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  );
}

function userMessage(id: string, text: string) {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

function assistantMessage(id: string, text: string) {
  return {
    id,
    role: "assistant",
    status: { type: "complete", reason: "stop" },
    parts: [{ type: "text", text }],
  };
}

describe("LLM chat session storage", () => {
  it("migrates v17 tables on fresh databases", () => {
    const db = freshDb();
    try {
      const version = (db.prepare("SELECT version FROM meta_schema WHERE id = 1").get() as { version: number }).version;
      expect(version).toBe(17);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'llm_chat_%' ORDER BY name")
        .all() as { name: string }[];
      expect(tables.map((t) => t.name)).toEqual([
        "llm_chat_messages",
        "llm_chat_sessions",
      ]);
    } finally {
      db.close();
    }
  });

  it("syncs normalized messages with raw JSON and derived text", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      const detail = syncLlmChatSession(db, session.id, {
        messages: [
          userMessage("u1", "Explain the bug"),
          assistantMessage("a1", "The bug is in the route."),
        ],
      });

      expect(detail.title).toBe("Explain the bug");
      expect(detail.message_count).toBe(2);
      expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(detail.messages[0].plain_text).toBe("Explain the bug");
      expect(JSON.parse(detail.messages[1].raw_json)).toMatchObject({ id: "a1" });
    } finally {
      db.close();
    }
  });

  it("diff sync updates, reorders, inserts, and deletes messages transactionally", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      syncLlmChatSession(db, session.id, {
        messages: [
          userMessage("u1", "First"),
          assistantMessage("a1", "Old answer"),
          userMessage("u2", "Remove me"),
        ],
      });

      const updated = syncLlmChatSession(db, session.id, {
        messages: [
          userMessage("u1", "First edited"),
          userMessage("u3", "New follow up"),
          assistantMessage("a1", "Updated answer"),
        ],
      });

      expect(updated.messages.map((m) => m.message_id)).toEqual(["u1", "u3", "a1"]);
      expect(updated.messages.map((m) => m.message_index)).toEqual([0, 1, 2]);
      expect(updated.messages[0].plain_text).toBe("First edited");
      expect(updated.messages.find((m) => m.message_id === "u2")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("lists, reads, syncs, and deletes sessions through Hono routes", async () => {
    const db = freshDb();
    try {
      const app = createApp({ db });
      const createdRes = await app.request("/api/llm-chat/sessions", {
        method: "POST",
        body: JSON.stringify({ title: "Manual title" }),
      });
      expect(createdRes.status).toBe(200);
      const created = (await createdRes.json()) as { session: { id: string } };

      const syncRes = await app.request(`/api/llm-chat/sessions/${created.session.id}/sync`, {
        method: "POST",
        body: JSON.stringify({
          messages: [userMessage("u1", "Hello"), assistantMessage("a1", "Hi")],
        }),
      });
      expect(syncRes.status).toBe(200);

      const listRes = await app.request("/api/llm-chat/sessions");
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as { sessions: Array<{ title: string }> };
      expect(list.sessions[0].title).toBe("Hello");

      const detailRes = await app.request(`/api/llm-chat/sessions/${created.session.id}`);
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as { session: { messages: unknown[] } };
      expect(detail.session.messages).toHaveLength(2);

      const deleteRes = await app.request(`/api/llm-chat/sessions/${created.session.id}`, {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(200);
      expect(getLlmChatSession(db, created.session.id)).toBeNull();
      expect(listLlmChatSessions(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
