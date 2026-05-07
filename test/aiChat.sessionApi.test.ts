// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAiChatSession,
  deleteAiChatSession,
  listAiChatSessions,
  syncAiChatSession,
} from "../web/src/aiChat/sessionApi";

describe("AI chat session API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps list/create/sync/delete responses", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/llm-chat/sessions?limit=50") {
        return json({ sessions: [{ id: "s1", title: "One" }] });
      }
      if (url === "/api/llm-chat/sessions" && init?.method === "POST") {
        return json({ session: { id: "s2", title: "Two" } });
      }
      if (url === "/api/llm-chat/sessions/s2/sync") {
        return json({ session: { id: "s2", title: "Two", messages: [] } });
      }
      if (url === "/api/llm-chat/sessions/s2" && init?.method === "DELETE") {
        return json({ ok: true });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listAiChatSessions()).resolves.toEqual([{ id: "s1", title: "One" }]);
    await expect(createAiChatSession("Two")).resolves.toMatchObject({ id: "s2" });
    await expect(syncAiChatSession("s2", [])).resolves.toMatchObject({ id: "s2" });
    await expect(deleteAiChatSession("s2")).resolves.toBeUndefined();
  });

  it("throws API error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "boom" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    await expect(listAiChatSessions()).rejects.toThrow("boom");
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
