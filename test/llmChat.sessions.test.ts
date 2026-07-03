import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";
import {
  createLlmChatSession,
  ensureLlmChatSession,
  getLlmChatSession,
  listLlmChatSessions,
  replaceLlmChatSessionMessages,
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
    content: text,
  };
}

function assistantMessage(id: string, text: string) {
  return {
    id,
    role: "assistant",
    content: text,
  };
}

function assistantToolCallMessage(id: string) {
  return {
    id,
    role: "assistant",
    toolCalls: [
      {
        id: "call-web-1",
        type: "function",
        function: {
          name: "ai2nao_web_search",
          arguments: JSON.stringify({ query: "Brave Search API", reason: "current web docs" }),
        },
      },
    ],
  };
}

function toolEvidenceMessage(id: string) {
  return {
    id,
    role: "tool",
    toolCallId: "call-web-1",
    content: JSON.stringify({
      ok: true,
      kind: "evidence",
      source: "web",
      query: "Brave Search API",
      generatedAt: "2026-05-17T00:00:00.000Z",
      evidence: [
        {
          title: "Brave Search API",
          url: "https://api.search.brave.com/",
          snippet: "Search API docs",
        },
      ],
      meta: { provider: "brave" },
    }),
  };
}

describe("LLM chat session storage", () => {
  it("migrates CopilotKit chat and Bash permission tables on fresh databases", () => {
    const db = freshDb();
    try {
      const version = (db.prepare("SELECT version FROM meta_schema WHERE id = 1").get() as { version: number }).version;
      expect(version).toBe(43);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('llm_chat_messages', 'llm_chat_sessions', 'bash_permission_rules') ORDER BY name")
        .all() as { name: string }[];
      expect(tables.map((t) => t.name)).toEqual([
        "bash_permission_rules",
        "llm_chat_messages",
        "llm_chat_sessions",
      ]);
    } finally {
      db.close();
    }
  });

  it("persists normalized AG-UI messages with raw JSON and derived text", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      const detail = replaceLlmChatSessionMessages(db, session.id, {
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

  it("persists AG-UI tool calls and tool results without polluting title or message count", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      const detail = replaceLlmChatSessionMessages(db, session.id, {
        messages: [
          userMessage("u1", "Find current Brave Search API docs"),
          assistantToolCallMessage("a-tool"),
          toolEvidenceMessage("tool-web"),
          assistantMessage("a1", "I found one current web source."),
        ],
      });

      expect(detail.title).toBe("Find current Brave Search API docs");
      expect(detail.message_count).toBe(2);
      expect(detail.messages.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
      ]);
      expect(detail.messages.find((m) => m.message_id === "a-tool")?.preview).toBe(
        "[tool call] ai2nao_web_search"
      );
      expect(detail.messages.find((m) => m.message_id === "tool-web")?.preview).toBe(
        "[evidence] web · 1 result"
      );
      expect(JSON.parse(detail.messages.find((m) => m.message_id === "tool-web")!.raw_json)).toMatchObject({
        role: "tool",
        toolCallId: "call-web-1",
      });
    } finally {
      db.close();
    }
  });

  it("keeps legacy text-only CopilotKit sessions readable after the tool-message migration", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      const detail = replaceLlmChatSessionMessages(db, session.id, {
        messages: [
          userMessage("u1", "Existing chat question"),
          assistantMessage("a1", "Existing chat answer"),
        ],
      });

      const reloaded = getLlmChatSession(db, detail.id);
      expect(reloaded?.title).toBe("Existing chat question");
      expect(reloaded?.message_count).toBe(2);
      expect(reloaded?.messages.map((m) => m.plain_text)).toEqual([
        "Existing chat question",
        "Existing chat answer",
      ]);
      expect(reloaded?.messages.map((m) => JSON.parse(m.raw_json).role)).toEqual([
        "user",
        "assistant",
      ]);
    } finally {
      db.close();
    }
  });

  it("replaces, reorders, inserts, and deletes messages transactionally", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      replaceLlmChatSessionMessages(db, session.id, {
        messages: [
          userMessage("u1", "First"),
          assistantMessage("a1", "Old answer"),
          userMessage("u2", "Remove me"),
        ],
      });

      const updated = replaceLlmChatSessionMessages(db, session.id, {
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

  it("lists, reads, and deletes sessions through Hono routes", async () => {
    const db = freshDb();
    try {
      const app = createApp({ db });
      const createdRes = await app.request("/api/llm-chat/sessions", {
        method: "POST",
        body: JSON.stringify({ title: "Manual title" }),
      });
      expect(createdRes.status).toBe(200);
      const created = (await createdRes.json()) as { session: { id: string } };

      replaceLlmChatSessionMessages(db, created.session.id, {
        messages: [userMessage("u1", "Hello"), assistantMessage("a1", "Hi")],
      });

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

  it("mounts CopilotKit v2 as the single-route endpoint used by the React client", async () => {
    const db = freshDb();
    try {
      const app = createApp({ db });
      const res = await app.request("/api/copilotkit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "info", params: {}, body: {} }),
      });

      expect(res.status).toBe(200);
      const info = (await res.json()) as {
        agents?: {
          default?: {
            className?: string;
            capabilities?: { tools?: { clientProvided?: boolean } };
          };
        };
      };
      expect(info.agents?.default?.className).toBe("Ai2NaoTransportAgent");
      expect(info.agents?.default?.capabilities?.tools?.clientProvided).toBe(false);
    } finally {
      db.close();
    }
  });

  it("serves direct CopilotKit v2 multi-route info and stop endpoints", async () => {
    const db = freshDb();
    try {
      const app = createApp({ db });
      const infoRes = await app.request("/api/copilotkit/info");

      expect(infoRes.status).toBe(200);
      const info = (await infoRes.json()) as {
        agents?: {
          default?: {
            className?: string;
            capabilities?: { tools?: { clientProvided?: boolean } };
          };
        };
      };
      expect(info.agents?.default?.className).toBe("Ai2NaoTransportAgent");
      expect(info.agents?.default?.capabilities?.tools?.clientProvided).toBe(false);

      const stopRes = await app.request("/api/copilotkit/agent/default/stop/not-running", {
        method: "POST",
      });
      expect(stopRes.status).toBe(200);
      const stopBody = (await stopRes.json()) as { stopped?: boolean; message?: string };
      expect(stopBody.stopped).toBe(false);
      expect(stopBody.message).toContain("No active run");
    } finally {
      db.close();
    }
  });

  it("serves CopilotKit UI transport snapshots through the runtime transport adapter", async () => {
    const db = freshDb();
    try {
      const app = createApp({ db });
      ensureLlmChatSession(db, "thread-1");
      replaceLlmChatSessionMessages(db, "thread-1", {
        messages: [userMessage("u1", "之前的问题"), assistantMessage("a1", "之前的回答")],
      });

      const res = await app.request("/api/copilotkit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "agent/connect",
          params: { agentId: "default" },
          body: {
            threadId: "thread-1",
            runId: "run-1",
            messages: [],
            tools: [],
            context: [],
            state: {},
            forwardedProps: {},
          },
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("RUN_STARTED");
      expect(text).toContain("MESSAGES_SNAPSHOT");
      expect(text).toContain("之前的问题");
      expect(text).toContain("RUN_FINISHED");

      const multiRouteRes = await app.request("/api/copilotkit/agent/default/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-1",
          runId: "run-2",
          messages: [],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      });
      expect(multiRouteRes.status).toBe(200);
      expect(multiRouteRes.headers.get("content-type")).toContain("text/event-stream");
      const multiRouteText = await multiRouteRes.text();
      expect(multiRouteText).toContain("MESSAGES_SNAPSHOT");
      expect(multiRouteText).toContain("之前的问题");
    } finally {
      db.close();
    }
  });
});
