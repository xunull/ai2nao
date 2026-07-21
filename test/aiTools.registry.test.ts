import { describe, expect, it } from "vitest";
import { AI_TOOL_REGISTRY } from "../src/aiTools/registry.js";

describe("AI_TOOL_REGISTRY 卫生", () => {
  it("toolKey 全局唯一", () => {
    const keys = AI_TOOL_REGISTRY.map((f) => f.toolKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("每条至少有一个匹配键(否则永远匹配不到任何东西)", () => {
    for (const fp of AI_TOOL_REGISTRY) {
      const hasMatch = Boolean(
        fp.macBundleId ||
          fp.macBundleIdPrefix ||
          fp.macNameExact ||
          fp.brewFormula ||
          fp.brewCask ||
          fp.binaries?.length
      );
      expect(hasMatch, `${fp.toolKey} 没有任何匹配键`).toBe(true);
    }
  });

  it("kind 只用已定义的四类", () => {
    const KINDS = new Set(["desktop-app", "cli", "local-runtime", "ide-extension"]);
    for (const fp of AI_TOOL_REGISTRY) {
      expect(KINDS.has(fp.kind), `${fp.toolKey} kind 非法:${fp.kind}`).toBe(true);
    }
  });
});
