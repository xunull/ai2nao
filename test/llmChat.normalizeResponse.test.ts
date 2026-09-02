import { describe, expect, it } from "vitest";
import { normalizeAssistantText, splitThinkBlocks } from "../src/llmChat/normalizeResponse.js";

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
