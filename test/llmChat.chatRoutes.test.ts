import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerLlmChatChatRoutes } from "../src/llmChat/chatRoutes.js";

const ai = vi.hoisted(() => ({
  convertToModelMessages: vi.fn(),
  streamText: vi.fn(),
}));

const model = vi.hoisted(() => ({
  createChatLanguageModel: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    convertToModelMessages: ai.convertToModelMessages,
    streamText: ai.streamText,
  };
});

vi.mock("../src/llmChat/config.js", () => ({
  llmChatStatus: () => ({
    configured: true,
    provider: "openai-compatible",
    model: "fake-model",
    baseHost: "127.0.0.1:11434",
    configPath: "/tmp/llm-chat.json",
  }),
  readLlmChatConfig: () => ({
    provider: "openai-compatible",
    baseURL: "http://127.0.0.1:11434/v1",
    model: "fake-model",
    apiKey: "test",
  }),
}));

vi.mock("../src/llmChat/model.js", () => ({
  createChatLanguageModel: model.createChatLanguageModel,
}));

describe("LLM chat route protocol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ai.convertToModelMessages.mockResolvedValue([{ role: "user", content: "Hello" }]);
    ai.streamText.mockReturnValue({
      toUIMessageStreamResponse: () => new Response("ok", { status: 200 }),
    });
    model.createChatLanguageModel.mockReturnValue({ id: "fake-model" });
  });

  it("rejects malformed assistant-ui messages before calling the model", async () => {
    const app = new Hono();
    registerLlmChatChatRoutes(app);

    const res = await app.request("/api/llm-chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ id: "m1", role: "user" }],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { message: expect.stringContaining("must have parts") },
    });
    expect(ai.streamText).not.toHaveBeenCalled();
  });

  it("passes valid UI messages through the model transport", async () => {
    const app = new Hono();
    registerLlmChatChatRoutes(app);

    const res = await app.request("/api/llm-chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [userMessage("m1", "Hello")],
      }),
    });

    expect(res.status).toBe(200);
    expect(ai.convertToModelMessages).toHaveBeenCalledWith([userMessage("m1", "Hello")]);
    expect(ai.streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { id: "fake-model" },
        messages: [{ role: "user", content: "Hello" }],
      })
    );
  });
});

function userMessage(id: string, text: string) {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  };
}
