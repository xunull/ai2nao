import { describe, expect, it } from "vitest";
import { parseLlmChatConfigJson } from "../src/llmChat/config.js";

describe("parseLlmChatConfigJson", () => {
  it("parses deepseek config with the official base URL default", () => {
    const cfg = parseLlmChatConfigJson(
      JSON.stringify({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: "x",
      })
    );
    expect(cfg).toEqual({
      provider: "deepseek",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      apiKey: "x",
    });
  });

  it("parses openai config with the official base URL default", () => {
    const cfg = parseLlmChatConfigJson(
      JSON.stringify({
        provider: "openai",
        model: "gpt-4o-mini",
      })
    );
    expect(cfg).toEqual({
      provider: "openai",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: undefined,
    });
  });

  it("parses moonshotai config with the official base URL default", () => {
    const cfg = parseLlmChatConfigJson(
      JSON.stringify({
        provider: "moonshotai",
        model: "kimi-k2",
        apiKey: "x",
      })
    );
    expect(cfg).toEqual({
      provider: "moonshotai",
      baseURL: "https://api.moonshot.ai/v1",
      model: "kimi-k2",
      apiKey: "x",
    });
  });

  it("parses alibaba config with the DashScope base URL default", () => {
    const cfg = parseLlmChatConfigJson(
      JSON.stringify({
        provider: "alibaba",
        model: "qwen-plus-latest",
      })
    );
    expect(cfg).toEqual({
      provider: "alibaba",
      baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus-latest",
      apiKey: undefined,
    });
  });

  it("parses openai-compatible config", () => {
    const cfg = parseLlmChatConfigJson(
      JSON.stringify({
        provider: "openai-compatible",
        baseURL: "http://127.0.0.1:11434/v1",
        model: "llama3.2",
        apiKey: "x",
      })
    );
    expect(cfg).toEqual({
      provider: "openai-compatible",
      baseURL: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      apiKey: "x",
    });
  });

  it("allows omitting apiKey", () => {
    const cfg = parseLlmChatConfigJson(
      JSON.stringify({
        provider: "openai-compatible",
        baseURL: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      })
    );
    expect(cfg?.apiKey).toBeUndefined();
  });

  it("requires baseURL for openai-compatible config", () => {
    expect(
      parseLlmChatConfigJson(
        JSON.stringify({
          provider: "openai-compatible",
          model: "llama3.2",
        })
      )
    ).toBeNull();
  });

  it("rejects invalid provider", () => {
    expect(
      parseLlmChatConfigJson(
        JSON.stringify({
          provider: "other",
          baseURL: "http://x",
          model: "m",
        })
      )
    ).toBeNull();
  });

  it("rejects malformed json", () => {
    expect(parseLlmChatConfigJson("{")).toBeNull();
  });
});
