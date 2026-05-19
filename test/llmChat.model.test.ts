import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatLanguageModel } from "../src/llmChat/model.js";

const providerMocks = vi.hoisted(() => ({
  createAlibabaMock: vi.fn(),
  alibabaChatModelMock: vi.fn((model: string) => ({ provider: "alibaba", model })),
  createDeepSeekMock: vi.fn(),
  deepseekChatMock: vi.fn((model: string) => ({ provider: "deepseek", model })),
  createMoonshotAIMock: vi.fn(),
  moonshotAIChatModelMock: vi.fn((model: string) => ({ provider: "moonshotai", model })),
  createOpenAIMock: vi.fn(),
  openaiChatMock: vi.fn((model: string) => ({ provider: "openai", model })),
  createOpenAICompatibleMock: vi.fn(),
  openaiCompatibleChatModelMock: vi.fn((model: string) => ({
    provider: "openai-compatible",
    model,
  })),
}));

vi.mock("@ai-sdk/alibaba", () => ({
  createAlibaba: providerMocks.createAlibabaMock,
}));

vi.mock("@ai-sdk/deepseek", () => ({
  createDeepSeek: providerMocks.createDeepSeekMock,
}));

vi.mock("@ai-sdk/moonshotai", () => ({
  createMoonshotAI: providerMocks.createMoonshotAIMock,
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: providerMocks.createOpenAIMock,
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: providerMocks.createOpenAICompatibleMock,
}));

const previousEnv = {
  ALIBABA_API_KEY: process.env.ALIBABA_API_KEY,
  AI2NAO_LLM_API_KEY: process.env.AI2NAO_LLM_API_KEY,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

beforeEach(() => {
  delete process.env.ALIBABA_API_KEY;
  delete process.env.AI2NAO_LLM_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  delete process.env.OPENAI_API_KEY;
  providerMocks.createAlibabaMock.mockReturnValue({
    chatModel: providerMocks.alibabaChatModelMock,
  });
  providerMocks.createDeepSeekMock.mockReturnValue({ chat: providerMocks.deepseekChatMock });
  providerMocks.createMoonshotAIMock.mockReturnValue({
    chatModel: providerMocks.moonshotAIChatModelMock,
  });
  providerMocks.createOpenAIMock.mockReturnValue({ chat: providerMocks.openaiChatMock });
  providerMocks.createOpenAICompatibleMock.mockReturnValue({
    chatModel: providerMocks.openaiCompatibleChatModelMock,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("createChatLanguageModel", () => {
  it("uses the DeepSeek provider and DeepSeek-specific API key", () => {
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.DEEPSEEK_API_KEY = "deepseek-key";

    const model = createChatLanguageModel({
      provider: "deepseek",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
    });

    expect(model).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro" });
    expect(providerMocks.createDeepSeekMock).toHaveBeenCalledWith({
      baseURL: "https://api.deepseek.com",
      apiKey: "deepseek-key",
    });
    expect(providerMocks.deepseekChatMock).toHaveBeenCalledWith("deepseek-v4-pro");
  });

  it("uses the Moonshot provider and Moonshot-specific API key", () => {
    process.env.MOONSHOT_API_KEY = "moonshot-key";
    process.env.OPENAI_API_KEY = "openai-key";

    createChatLanguageModel({
      provider: "moonshotai",
      baseURL: "https://api.moonshot.ai/v1",
      model: "kimi-k2",
    });

    expect(providerMocks.createMoonshotAIMock).toHaveBeenCalledWith({
      baseURL: "https://api.moonshot.ai/v1",
      apiKey: "moonshot-key",
    });
    expect(providerMocks.moonshotAIChatModelMock).toHaveBeenCalledWith("kimi-k2");
  });

  it("uses the Alibaba provider and Alibaba-specific API key", () => {
    process.env.ALIBABA_API_KEY = "alibaba-key";
    process.env.AI2NAO_LLM_API_KEY = "shared-key";

    createChatLanguageModel({
      provider: "alibaba",
      baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus-latest",
    });

    expect(providerMocks.createAlibabaMock).toHaveBeenCalledWith({
      baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      apiKey: "alibaba-key",
    });
    expect(providerMocks.alibabaChatModelMock).toHaveBeenCalledWith("qwen-plus-latest");
  });

  it("uses the OpenAI provider and OpenAI-specific API key", () => {
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.AI2NAO_LLM_API_KEY = "shared-key";

    createChatLanguageModel({
      provider: "openai",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });

    expect(providerMocks.createOpenAIMock).toHaveBeenCalledWith({
      baseURL: "https://api.openai.com/v1",
      apiKey: "openai-key",
    });
    expect(providerMocks.openaiChatMock).toHaveBeenCalledWith("gpt-4o-mini");
  });

  it("keeps openai-compatible endpoints on the generic provider", () => {
    process.env.AI2NAO_LLM_API_KEY = "shared-key";

    createChatLanguageModel({
      provider: "openai-compatible",
      baseURL: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
    });

    expect(providerMocks.createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "openai-compatible",
      baseURL: "http://127.0.0.1:11434/v1",
      apiKey: "shared-key",
    });
    expect(providerMocks.openaiCompatibleChatModelMock).toHaveBeenCalledWith("llama3.2");
  });

  it("keeps a placeholder key for local openai-compatible servers", () => {
    createChatLanguageModel({
      provider: "openai-compatible",
      baseURL: "http://127.0.0.1:1234/v1",
      model: "local-model",
    });

    expect(providerMocks.createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "openai-compatible",
      baseURL: "http://127.0.0.1:1234/v1",
      apiKey: "local-no-key",
    });
  });
});
