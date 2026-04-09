import { describe, expect, it } from "vitest";
import { splitMarkdownFences } from "../web/src/util/splitMarkdownFences.js";

describe("splitMarkdownFences", () => {
  it("splits text and one fenced block", () => {
    const md = "intro\n```ts\nconst x = 1\n```\ntrailer";
    const segs = splitMarkdownFences(md);
    expect(segs).toEqual([
      { type: "text", value: "intro\n" },
      { type: "code", lang: "ts", value: "const x = 1" },
      { type: "text", value: "\ntrailer" },
    ]);
  });

  it("handles empty fence lang", () => {
    const md = "```\nplain\n```";
    expect(splitMarkdownFences(md)).toEqual([
      { type: "code", lang: "", value: "plain" },
    ]);
  });
});
