import { describe, expect, it } from "vitest";
import {
  formatTokenCount,
  formatTokenCoverage,
} from "../web/src/util/formatDisplay";

describe("formatDisplay token helpers", () => {
  it("formats token counts compactly", () => {
    expect(formatTokenCount(undefined)).toBe("—");
    expect(formatTokenCount(-1)).toBe("—");
    expect(formatTokenCount(873)).toBe("873");
    expect(formatTokenCount(12_400)).toBe("12.4K");
    expect(formatTokenCount(4_800_000)).toBe("4.8M");
  });

  it("formats token coverage labels", () => {
    expect(formatTokenCoverage("full")).toBe("真实 token");
    expect(formatTokenCoverage("partial")).toBe("部分 token");
    expect(formatTokenCoverage("unknown")).toBe("token 未知");
    expect(formatTokenCoverage(undefined)).toBe("token 未知");
  });
});
