import { describe, expect, it } from "vitest";
import {
  formatTokenCount,
  formatTokenCoverage,
  formatUsd,
} from "../web/src/util/formatDisplay";

describe("formatDisplay token helpers", () => {
  it("formats token counts compactly", () => {
    expect(formatTokenCount(undefined)).toBe("—");
    expect(formatTokenCount(-1)).toBe("—");
    expect(formatTokenCount(873)).toBe("873");
    expect(formatTokenCount(12_400)).toBe("12.4K");
    expect(formatTokenCount(4_800_000)).toBe("4.8M");
  });

  it("formats USD amounts per the spec", () => {
    expect(formatUsd(undefined)).toBe("—");
    expect(formatUsd(-1)).toBe("—");
    expect(formatUsd(0)).toBe("$0.00");
    // 比下限还小:显示下限,不能四舍五入成 $0.0000 —— 那看起来像没花钱。
    expect(formatUsd(0.00001)).toBe("<$0.0001");
    expect(formatUsd(0.0011)).toBe("$0.0011");
    // ★ 两位有效数字要保住尾零,否则 $0.10 会显示成 $0.1,与同列对不齐。
    expect(formatUsd(0.1)).toBe("$0.10");
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatUsd(12.345)).toBe("$12.35");
  });

  it("formats token coverage labels", () => {
    expect(formatTokenCoverage("full")).toBe("真实 token");
    expect(formatTokenCoverage("partial")).toBe("部分 token");
    expect(formatTokenCoverage("unknown")).toBe("token 未知");
    expect(formatTokenCoverage(undefined)).toBe("token 未知");
  });
});
