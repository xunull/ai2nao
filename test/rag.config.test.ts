import { describe, expect, it } from "vitest";
import { parseRagConfigJson } from "../src/rag/config.js";

describe("parseRagConfigJson", () => {
  it("accepts includeExtensions without a leading dot (e.g. md → .md)", () => {
    const cfg = parseRagConfigJson(
      JSON.stringify({
        version: 1,
        corpusRoots: ["/tmp/n"],
        includeExtensions: ["md", ".TXT", "rtf"],
      })
    );
    expect(cfg).not.toBeNull();
    expect(cfg!.includeExtensions).toEqual([".md", ".txt", ".rtf"]);
  });

  it("falls back to default extensions when array is empty", () => {
    const cfg = parseRagConfigJson(
      JSON.stringify({
        version: 1,
        corpusRoots: ["/tmp/n"],
        includeExtensions: [],
      })
    );
    expect(cfg).not.toBeNull();
    expect(cfg!.includeExtensions).toEqual([".md", ".mdx", ".txt"]);
  });
});
