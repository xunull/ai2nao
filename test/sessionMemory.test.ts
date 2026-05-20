import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSessionMemoryService } from "../src/sessionMemory/service.js";
import {
  createLlmChatSession,
  replaceLlmChatSessionMessages,
} from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";

function tempPath(name: string): string {
  return join(tmpdir(), `ai2nao-session-memory-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

describe("session memory service", () => {
  it("searches persisted ai2nao chat sessions as local evidence snippets", async () => {
    const dbPath = tempPath("ai-chat.db");
    const db = openDatabase(dbPath);
    try {
      const session = createLlmChatSession(db);
      replaceLlmChatSessionMessages(db, session.id, {
        messages: [
          { id: "u1", role: "user", content: "帮我做 web search server-side tool 的方案" },
          { id: "a1", role: "assistant", content: "我们决定让后端自己执行工具调用。" },
        ],
      });

      const service = createSessionMemoryService({ db, now: () => new Date("2026-05-19T00:00:00.000Z") });
      const result = await service.search({
        query: "web search server-side tool",
        sources: ["ai-chat"],
        count: 3,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.source).toBe("session");
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]).toMatchObject({
        source: "session",
        provider: "ai-chat",
        matchedBy: ["session-memory", "ai-chat"],
      });
      expect(result.evidence[0].snippet).toContain("web search server-side tool");
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
    }
  });

  it("returns a typed error for empty queries", async () => {
    const dbPath = tempPath("empty-query.db");
    const db = openDatabase(dbPath);
    try {
      const service = createSessionMemoryService({ db });
      const result = await service.search({ query: "   " });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.source).toBe("session");
      expect(result.code).toBe("invalid_query");
      expect(result.recoverable).toBe(false);
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
    }
  });

  it("keeps useful hits when one source fails", async () => {
    const service = createSessionMemoryService({
      now: () => new Date("2026-05-19T00:00:00.000Z"),
      sources: {
        codex: async () => [
          {
            source: "codex",
            sessionId: "codex-1",
            title: "Session memory plan",
            workspacePath: "/repo",
            snippet: "The selected approach was B: search existing session history directly.",
            score: 42,
            updatedAt: "2026-05-18T00:00:00.000Z",
          },
        ],
        cursor: async () => {
          throw new Error("Cursor database is locked");
        },
      },
    });

    const result = await service.search({
      query: "session history",
      sources: ["codex", "cursor"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].provider).toBe("codex");
    expect(result.meta.warnings?.[0]).toContain("cursor");
  });
});
