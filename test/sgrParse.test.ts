import { describe, expect, it } from "vitest";
import { sgrParse } from "../web/src/util/sgrParse.js";

// 真实数据是无-ESC 残骸(用 [Nm 字面);真 ESC 用 \x1b 前缀。两者都要过。
const ESC = "\x1b";

describe("sgrParse —— SGR 残骸/ANSI 状态机", () => {
  it("无 SGR 码 → 单个无样式 span", () => {
    expect(sgrParse("hello world")).toEqual([{ text: "hello world" }]);
  });

  it("空串 → 空数组", () => {
    expect(sgrParse("")).toEqual([]);
  });

  it("无-ESC 残骸:[1m..[22m 还原成加粗(真实数据形态)", () => {
    const s = sgrParse("Set model to [1mOpus 4.7[22m and saved");
    expect(s).toEqual([
      { text: "Set model to " },
      { text: "Opus 4.7", bold: true },
      { text: " and saved" },
    ]);
  });

  it("真 ESC ANSI 也吃(将来数据源变了不坏)", () => {
    const s = sgrParse(`${ESC}[1mbold${ESC}[22m plain`);
    expect(s).toEqual([
      { text: "bold", bold: true },
      { text: " plain" },
    ]);
  });

  it("斜体 / 下划线 开关", () => {
    expect(sgrParse("[3mi[23m [4mu[24m")).toEqual([
      { text: "i", italic: true },
      { text: " " },
      { text: "u", underline: true },
    ]);
  });

  it("reset [0m 清全部样式", () => {
    expect(sgrParse("[1m[4mx[0my")).toEqual([
      { text: "x", bold: true, underline: true },
      { text: "y" },
    ]);
  });

  it("空参 [m == reset", () => {
    expect(sgrParse("[1mx[my")).toEqual([
      { text: "x", bold: true },
      { text: "y" },
    ]);
  });

  it("多参 [1;31m 逐个 apply(加粗 + 红)", () => {
    expect(sgrParse("[1;31mred bold[0m")).toEqual([
      { text: "red bold", bold: true, fg: "red" },
    ]);
  });

  it("前景色 39 复位、背景色 49 复位", () => {
    expect(sgrParse("[32m[41mg[39mh[49mi")).toEqual([
      { text: "g", fg: "green", bg: "red" },
      { text: "h", bg: "red" },
      { text: "i" },
    ]);
  });

  it("亮色 90-97 / 100-107", () => {
    expect(sgrParse("[91mx")).toEqual([{ text: "x", fg: "bright-red" }]);
    expect(sgrParse("[104my")).toEqual([{ text: "y", bg: "bright-blue" }]);
  });

  it("未知码跳过且状态一致(不泄漏)", () => {
    // 7(反显)未支持 → 跳过;加粗状态不受影响。
    expect(sgrParse("[1m[7mx[22my")).toEqual([
      { text: "x", bold: true },
      { text: "y" },
    ]);
  });

  it("非数字参数不是合法 SGR token → 原样留作文本", () => {
    // [abcm 的参数含字母,不匹配 [0-9;]*m → 不当样式码,整串留文本(吞噬防护)。
    expect(sgrParse("[abcmx")).toEqual([{ text: "[abcmx" }]);
  });

  it("未知数字码(999)跳过,状态一致", () => {
    expect(sgrParse("[999mx")).toEqual([{ text: "x" }]);
  });
});
