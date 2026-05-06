import { describe, expect, it } from "vitest";
import { extractMessageText, messagePreview } from "../web/src/aiChat/messageText";

describe("AI chat message text helpers", () => {
  it("prefers assistant-ui parts over mirrored content arrays", () => {
    expect(
      extractMessageText({
        parts: [{ type: "text", text: "hello" }],
        content: [{ type: "text", text: "hello" }],
      })
    ).toBe("hello");
  });

  it("ignores unsupported parts and truncates previews", () => {
    const preview = messagePreview({
      parts: [{ type: "tool-call" }, { type: "text", text: "a".repeat(150) }],
    });
    expect(preview).toHaveLength(140);
    expect(preview.endsWith("...")).toBe(true);
  });
});
