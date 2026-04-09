import { describe, expect, it } from "vitest";
import { parseLlmChatConfigJson } from "../src/llmChat/config.js";

describe("parseLlmChatConfigJson", () => {
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
