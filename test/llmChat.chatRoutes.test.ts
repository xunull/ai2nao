import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerLlmChatChatRoutes } from "../src/llmChat/chatRoutes.js";

vi.mock("../src/llmChat/config.js", () => ({
  llmChatStatus: () => ({
    configured: true,
    provider: "openai-compatible",
    model: "fake-model",
    baseHost: "127.0.0.1:11434",
    configPath: "/tmp/llm-chat.json",
  }),
}));

describe("LLM chat status route", () => {
  it("keeps the status endpoint for the AI chat shell", async () => {
    const app = new Hono();
    registerLlmChatChatRoutes(app);

    const res = await app.request("/api/llm-chat/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      configured: true,
      model: "fake-model",
    });
  });
});
