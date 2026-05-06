import { describe, expect, it } from "vitest";
import {
  LlmChatMessageCodecError,
  textFromUiMessage,
  validateLlmChatUiMessages,
} from "../src/llmChat/messageCodec.js";

describe("LLM chat server message codec", () => {
  it("validates UIMessage arrays and preserves allowed unknown fields", () => {
    const messages = validateLlmChatUiMessages([
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
        metadata: { local: true },
      },
    ]);

    expect(messages[0]).toMatchObject({
      id: "u1",
      role: "user",
      metadata: { local: true },
    });
  });

  it("rejects messages without parts", () => {
    expect(() =>
      validateLlmChatUiMessages([{ id: "u1", role: "user", content: "hello" }])
    ).toThrow(LlmChatMessageCodecError);
  });

  it("rejects invalid roles and malformed text parts", () => {
    expect(() =>
      validateLlmChatUiMessages([{ id: "x", role: "tool", parts: [] }])
    ).toThrow("message 0 has invalid role");
    expect(() =>
      validateLlmChatUiMessages([{ id: "x", role: "assistant", parts: [{ type: "text" }] }])
    ).toThrow("message 0 part 0 must have text");
  });

  it("extracts readable text from text and reasoning parts only", () => {
    const [message] = validateLlmChatUiMessages([
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "visible" },
          { type: "reasoning", text: "reason" },
          { type: "step-start" },
        ],
      },
    ]);

    expect(textFromUiMessage(message)).toBe("visible\nreason");
  });
});
