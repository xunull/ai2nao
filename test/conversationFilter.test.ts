import { describe, expect, it } from "vitest";
import {
  computeAnchorIndex,
  filterByReadingHidden,
  mergeAdjacentAssistant,
} from "../web/src/util/conversationFilter";

type M = {
  id: string | null;
  role: string;
  content: string;
  thinking?: string;
  metadata?: { readingHidden?: "appendix" | "tool-only" | "injected" };
};

const msg = (id: string, role: string, content = "", extra: Partial<M> = {}): M => ({
  id,
  role,
  content,
  ...extra,
});
const hidden = (id: string, role: string, why: "appendix" | "tool-only" | "injected"): M =>
  msg(id, role, "", { metadata: { readingHidden: why } });

describe("filterByReadingHidden", () => {
  it("空数组 → 空数组", () => {
    expect(filterByReadingHidden([])).toEqual([]);
  });

  it("有 readingHidden 的滤掉,没有的留下", () => {
    const out = filterByReadingHidden([
      msg("1", "user", "真人问题"),
      hidden("2", "user", "tool-only"),
      msg("3", "assistant", "回答"),
      hidden("4", "assistant", "appendix"),
      hidden("5", "user", "injected"),
    ]);
    expect(out.map((m) => m.id)).toEqual(["1", "3"]);
  });

  it("全被滤掉 → 空数组(调用方据此判空态,不能白屏)", () => {
    expect(filterByReadingHidden([hidden("1", "user", "tool-only")])).toEqual([]);
  });

  it("thinking-only 的 assistant 没有标记 → 保留", () => {
    const out = filterByReadingHidden([msg("1", "assistant", "", { thinking: "想一下" })]);
    expect(out).toHaveLength(1);
  });
});

describe("mergeAdjacentAssistant", () => {
  it("空数组 → 空数组", () => {
    expect(mergeAdjacentAssistant([])).toEqual([]);
  });

  it("单条 → 一张卡", () => {
    const cards = mergeAdjacentAssistant([msg("1", "assistant", "hi")]);
    expect(cards).toHaveLength(1);
    expect(cards[0].messages.map((m) => m.id)).toEqual(["1"]);
  });

  it("相邻 assistant 合并成一张卡,key 与时间取首条", () => {
    const cards = mergeAdjacentAssistant([
      msg("a1", "assistant", "我先看一下"),
      msg("a2", "assistant", "看完了"),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].key).toBe("a1");
    expect(cards[0].messages.map((m) => m.id)).toEqual(["a1", "a2"]);
  });

  it("被 user 隔开的 assistant 不合并", () => {
    const cards = mergeAdjacentAssistant([
      msg("a1", "assistant", "答一"),
      msg("u1", "user", "追问"),
      msg("a2", "assistant", "答二"),
    ]);
    expect(cards.map((c) => c.messages.length)).toEqual([1, 1, 1]);
  });

  // 刻意不合并:user 连发两条是两次独立发言,合并会读成一段;
  // 而 assistant 的连续消息是同一轮被 jsonl 按 content block 拆开的,合并是还原。
  it("user 的连续消息不合并(与 assistant 语义不同)", () => {
    const cards = mergeAdjacentAssistant([
      msg("u1", "user", "第一句"),
      msg("u2", "user", "第二句"),
    ]);
    expect(cards).toHaveLength(2);
  });

  it("过滤后原本不相邻的 assistant 变相邻 → 合并(这正是阅读模式要的)", () => {
    const filtered = filterByReadingHidden([
      msg("a1", "assistant", "我先看一下"),
      hidden("a2", "assistant", "tool-only"),
      hidden("u1", "user", "tool-only"),
      msg("a3", "assistant", "看完了"),
    ]);
    const cards = mergeAdjacentAssistant(filtered);
    expect(cards).toHaveLength(1);
    expect(cards[0].messages.map((m) => m.id)).toEqual(["a1", "a3"]);
  });

  it("id 为 null 时 key 退化为角色+序号,不抛错", () => {
    const cards = mergeAdjacentAssistant([msg(null as unknown as string, "assistant", "x")]);
    expect(cards).toHaveLength(1);
    expect(typeof cards[0].key).toBe("string");
    expect(cards[0].key.length).toBeGreaterThan(0);
  });
});

describe("computeAnchorIndex", () => {
  const prev = [
    msg("a1", "assistant", "一"),
    hidden("x1", "assistant", "tool-only"),
    hidden("x2", "user", "tool-only"),
    msg("a2", "assistant", "二"),
    msg("u1", "user", "问"),
    msg("a3", "assistant", "三"),
  ];
  const cards = mergeAdjacentAssistant(filterByReadingHidden(prev));
  // cards: [ {a1,a2}, {u1}, {a3} ]

  it("锚点为 null → 0", () => {
    expect(computeAnchorIndex(cards, null, prev)).toBe(0);
  });

  it("锚点是某卡首条 → 该卡 index", () => {
    expect(computeAnchorIndex(cards, "a1", prev)).toBe(0);
    expect(computeAnchorIndex(cards, "u1", prev)).toBe(1);
  });

  // 架构4=A:scrollToIndex 定位不到卡内某段,落在卡中间就返回整卡
  it("锚点落在合并卡的中间一段 → 返回那张卡的 index", () => {
    expect(computeAnchorIndex(cards, "a2", prev)).toBe(0);
  });

  it("锚点自己被滤掉 → 往后找第一条仍可见的所在卡", () => {
    // x1 被滤,其后第一条可见的是 a2,a2 在第 0 张卡
    expect(computeAnchorIndex(cards, "x1", prev)).toBe(0);
  });

  it("锚点被滤掉且其后全被滤掉 → 落到最后一张卡", () => {
    const p = [msg("a1", "assistant", "一"), hidden("x9", "user", "tool-only")];
    const c = mergeAdjacentAssistant(filterByReadingHidden(p));
    expect(computeAnchorIndex(c, "x9", p)).toBe(0);
  });

  it("锚点不在 prev 里(数据已换) → 0,不抛错", () => {
    expect(computeAnchorIndex(cards, "不存在的id", prev)).toBe(0);
  });

  it("卡片为空 → 0", () => {
    expect(computeAnchorIndex([], "a1", prev)).toBe(0);
  });
});
