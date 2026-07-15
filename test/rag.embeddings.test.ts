import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEmbedding, fetchEmbeddingsBatch } from "../src/rag/embeddings.js";
import type { RagConfigV1 } from "../src/rag/types.js";

const { readLlmChatConfigMock } = vi.hoisted(() => ({
  readLlmChatConfigMock: vi.fn(),
}));

vi.mock("../src/llmChat/config.js", () => ({
  readLlmChatConfig: readLlmChatConfigMock,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function ragConfig(baseURL = ""): RagConfigV1 {
  return {
    version: 1,
    corpusRoots: [],
    includeExtensions: [".md"],
    maxFileBytes: 1024,
    respectDefaultExcludes: true,
    embedding: {
      enabled: true,
      baseURL,
      model: "text-embedding-3-small",
    },
  };
}

describe("RAG embeddings", () => {
  it("inherits embedding baseURL and key from openai-compatible LLM config", async () => {
    readLlmChatConfigMock.mockReturnValue({
      provider: "openai-compatible",
      baseURL: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      apiKey: "llm-key",
    });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchEmbedding("hello", ragConfig());

    expect(result.dim).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer llm-key" }),
      })
    );
  });

  it.each([
    {
      provider: "deepseek",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      apiKey: "deepseek-key",
    },
    {
      provider: "moonshotai",
      baseURL: "https://api.moonshot.ai/v1",
      model: "kimi-k2",
      apiKey: "moonshot-key",
    },
    {
      provider: "alibaba",
      baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus-latest",
      apiKey: "alibaba-key",
    },
  ])("does not inherit $provider chat config as an embedding endpoint", async (llmConfig) => {
    readLlmChatConfigMock.mockReturnValue(llmConfig);

    await expect(fetchEmbedding("hello", ragConfig())).rejects.toThrow(
      "embedding baseURL missing"
    );
    await expect(fetchEmbeddingsBatch(["hello"], ragConfig())).rejects.toThrow(
      "embedding baseURL missing"
    );
  });
});

describe("missing-key error clarity (T12)", () => {
  it("REMOTE endpoint with no key → clear error naming the settings page (not a 401)", async () => {
    readLlmChatConfigMock.mockReturnValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const savedLlm = process.env.AI2NAO_LLM_API_KEY;
    const savedOpenai = process.env.OPENAI_API_KEY;
    delete process.env.AI2NAO_LLM_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(fetchEmbedding("hi", ragConfig("https://dashscope.aliyuncs.com/compatible-mode/v1"))).rejects.toThrow(
        /RAG 知识库/
      );
      // It must fail BEFORE any network call — no misleading 401.
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (savedLlm !== undefined) process.env.AI2NAO_LLM_API_KEY = savedLlm;
      if (savedOpenai !== undefined) process.env.OPENAI_API_KEY = savedOpenai;
    }
  });

  it("LOCAL endpoint with no key → proceeds (LM Studio / Ollama need none)", async () => {
    readLlmChatConfigMock.mockReturnValue(null);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const savedLlm = process.env.AI2NAO_LLM_API_KEY;
    const savedOpenai = process.env.OPENAI_API_KEY;
    delete process.env.AI2NAO_LLM_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const result = await fetchEmbedding("hi", ragConfig("http://localhost:1234/v1"));
      expect(result.dim).toBe(2);
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      if (savedLlm !== undefined) process.env.AI2NAO_LLM_API_KEY = savedLlm;
      if (savedOpenai !== undefined) process.env.OPENAI_API_KEY = savedOpenai;
    }
  });
});
