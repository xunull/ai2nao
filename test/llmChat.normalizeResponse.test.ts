import { describe, expect, it } from "vitest";
import {
  ThinkStreamFilter,
  normalizeAssistantText,
  splitThinkBlocks,
} from "../src/llmChat/normalizeResponse.js";

/**
 * T0 实测(2026-09-02,真 API):
 *   DeepSeek v4-flash → content 为空,推理在 reasoning_content(159 字符)
 *   MiniMax-M2        → reasoning_content 为空,推理是 content 里的 <think>…</think>(100 字符)
 * content 是直接渲染进气泡的,不剥离就会把模型的思考过程当成回答显示出来。
 * 同一个根因仓里已有记录:hermesHistory/normalize.ts:46 的 isBadTitle() 就在查 "<think"。
 */
describe("splitThinkBlocks", () => {
  it("MiniMax 形状:<think> 块进 thinking,其余进 visible", () => {
    expect(splitThinkBlocks("<think>我要查天气</think>上海九月多雨。")).toEqual({
      visible: "上海九月多雨。",
      thinking: "我要查天气",
    });
  });

  it("没有 think 块时原样返回,不做任何加工", () => {
    expect(splitThinkBlocks("上海九月多雨。")).toEqual({
      visible: "上海九月多雨。",
      thinking: "",
    });
  });

  it("多个 think 块全部剥离并按序拼接", () => {
    expect(splitThinkBlocks("<think>甲</think>正文<think>乙</think>结尾")).toEqual({
      visible: "正文结尾",
      thinking: "甲\n乙",
    });
  });

  it("流式中途只开未闭:开标签之后的内容全部算 thinking,不能漏进气泡", () => {
    // 这是流式的关键分支 —— 分片到达时 </think> 还没来。
    expect(splitThinkBlocks("先说一句<think>我正在想")).toEqual({
      visible: "先说一句",
      thinking: "我正在想",
    });
  });

  it("带属性的开标签也认", () => {
    expect(splitThinkBlocks('<think type="reasoning">甲</think>乙')).toEqual({
      visible: "乙",
      thinking: "甲",
    });
  });

  it("空串", () => {
    expect(splitThinkBlocks("")).toEqual({ visible: "", thinking: "" });
  });
});

describe("normalizeAssistantText —— 两家归到同一形状", () => {
  it("SC11 MiniMax:content 里的 <think> 剥出来归入 reasoning", () => {
    expect(
      normalizeAssistantText({ content: "<think>A</think>B", reasoningContent: null })
    ).toEqual({ text: "B", reasoning: "A" });
  });

  it("SC11 DeepSeek:reasoning_content 直接归入 reasoning", () => {
    expect(normalizeAssistantText({ content: "", reasoningContent: "A" })).toEqual({
      text: "",
      reasoning: "A",
    });
  });

  it("两者都有时不丢任何一边", () => {
    expect(
      normalizeAssistantText({ content: "<think>甲</think>正文", reasoningContent: "乙" })
    ).toEqual({ text: "正文", reasoning: "乙\n甲" });
  });

  it("普通厂商(无推理)原样穿过", () => {
    expect(normalizeAssistantText({ content: "正文", reasoningContent: null })).toEqual({
      text: "正文",
      reasoning: "",
    });
  });

  it("归一后的可见文本里绝不含 <think", () => {
    const out = normalizeAssistantText({
      content: "<think>用户想要查询2026年9月上海的天气</think>上海九月多雨。",
      reasoningContent: null,
    });
    expect(out.text).not.toContain("<think");
  });
});

describe("ThinkStreamFilter —— 流式剥离，分片切在标签中间也不能漏", () => {
  /** 把分片依次喂进去，返回真正吐给前端的可见文本。 */
  function stream(parts: string[]): string {
    const f = new ThinkStreamFilter();
    return parts.map((p) => f.push(p)).join("") + f.finish();
  }

  it("整块 think 一次到达", () => {
    expect(stream(["<think>想了想</think>答案"])).toBe("答案");
  });

  it("think 块跨多个分片 —— 中途一个字都不能漏进气泡", () => {
    // 这是真实形状：T0 实测 MiniMax 的第一条 delta 就是 "<think>\n用户问"。
    expect(stream(["<think>\n用户", "问的是什么", "\n</think>\n\n答案在这"])).toBe("答案在这");
  });

  it("开标签被分片切开（<thi + nk>）也不能漏出去", () => {
    // 朴素实现会在只看到 "<thi" 时判定它是普通文本并吐出去，
    // 等 "nk>" 到了才发现是标签 —— 那时已经晚了。
    expect(stream(["前言", "<thi", "nk>秘密", "</think>正文"])).toBe("前言正文");
  });

  it("闭标签被切开同样处理", () => {
    expect(stream(["<think>x</thi", "nk>正文"])).toBe("正文");
  });

  it("普通文本逐字流过，一个字都不少", () => {
    expect(stream(["上", "海九月", "多雨。"])).toBe("上海九月多雨。");
  });

  it("只有 think 没有正文 → 什么都不吐", () => {
    expect(stream(["<think>只在想</think>"])).toBe("");
  });

  it("流结束时仍未闭合的 think 不补吐出来", () => {
    // 模型被中断/超时的情况：宁可少显示，也不能把思考当答案。
    expect(stream(["正文", "<think>没说完"])).toBe("正文");
  });

  it("看起来像标签开头但其实是普通文本，最终要吐出来", () => {
    expect(stream(["a < b"])).toBe("a < b");
    expect(stream(["<thin"])).toBe("<thin");
  });

  it("多个 think 块交替", () => {
    expect(stream(["<think>甲</think>正", "文<think>乙</think>结尾"])).toBe("正文结尾");
  });
});
