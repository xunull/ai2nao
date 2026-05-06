// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  encodeMessageForSync,
  restoreStoredMessageRows,
  titleFromMessages,
  toThreadMessageLike,
  validateUiMessage,
} from "../web/src/aiChat/messageCodec";
import type { AiChatStoredMessage } from "../web/src/aiChat/types";

describe("AI chat frontend message codec", () => {
  it("restores stored messages from raw_json before plain text", () => {
    const restored = restoreStoredMessageRows([
      row({
        raw_json: JSON.stringify({
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "raw text" }],
        }),
        plain_text: "fallback text",
      }),
    ]);

    expect(restored.errors).toEqual([]);
    expect(restored.messages[0].parts).toEqual([{ type: "text", text: "raw text" }]);
  });

  it("falls back to plain_text when raw_json is malformed", () => {
    const restored = restoreStoredMessageRows([
      row({ raw_json: "{bad json", plain_text: "fallback text" }),
    ]);

    expect(restored.errors[0]).toContain("u1");
    expect(restored.messages[0]).toMatchObject({
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "fallback text" }],
    });
  });

  it("encodes strict UIMessage sync payloads", () => {
    const encoded = encodeMessageForSync({
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "answer" }],
      metadata: { saved: true },
    }, 0);

    expect(encoded).toMatchObject({
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "answer" }],
      metadata: { saved: true },
    });
  });

  it("converts assistant-ui thread content into AI SDK parts and back", () => {
    const encoded = encodeMessageForSync({
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "from runtime" }],
    }, 0);

    expect(encoded).toEqual({
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "from runtime" }],
    });
    expect(toThreadMessageLike(encoded)).toEqual({
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "from runtime" }],
      metadata: undefined,
      status: undefined,
    });
  });

  it("rejects invalid UIMessage shapes and derives titles", () => {
    expect(() => validateUiMessage({ id: "u1", role: "user", content: 123 })).toThrow(
      "message 0 must have parts"
    );
    expect(
      titleFromMessages([{ id: "u1", role: "user", parts: [{ type: "text", text: "hello world" }] }])
    ).toBe("hello world");
  });
});

function row(overrides: Partial<AiChatStoredMessage> = {}): AiChatStoredMessage {
  return {
    id: "row",
    session_id: "s1",
    message_id: "u1",
    message_index: 0,
    role: "user",
    raw_json: JSON.stringify({
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    }),
    plain_text: "hello",
    preview: "hello",
    status: null,
    created_at: "2026-05-06T00:00:00.000Z",
    updated_at: "2026-05-06T00:00:00.000Z",
    ...overrides,
  };
}
