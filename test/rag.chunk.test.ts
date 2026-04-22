import { describe, expect, it } from "vitest";
import { chunkText } from "../src/rag/chunk.js";

describe("chunkText", () => {
  it("splits long body", () => {
    const body = "a".repeat(500) + "\n\n" + "b".repeat(500) + "\n\n" + "c".repeat(500);
    const chunks = chunkText(body);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.join("")).toContain("aaa");
  });
});
