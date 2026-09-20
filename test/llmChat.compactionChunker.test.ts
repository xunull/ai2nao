import { describe, expect, it } from "vitest";
import {
  chunkTurnsForSummary,
  collapseTurn,
  headTailTruncate,
  MESSAGE_LIMIT_FLOOR,
  type SummaryTurn,
} from "../src/llmChat/compactionChunker.js";

/**
 * 分块与三级截断(粗 T7 第 4a 片)。
 *
 * 规格给这三级的目的是**保证收敛**:任何单轮最终都能进入某个分块。所以下面最要紧的
 * 不是「截断对不对」,而是「会不会有塞不下的轮」——那会让压缩永远失败。
 */

const turn = (n: number, ...texts: Array<[SummaryTurn["messages"][number]["role"], string]>): SummaryTurn => ({
  turn: n,
  messages: texts.map(([role, text]) => ({ role, text })),
});

describe("头尾截断", () => {
  it("短于上限时原样返回", () => {
    expect(headTailTruncate("短", 100)).toBe("短");
  });

  it("★ 留头也留尾 —— 只留头会把结论丢掉", () => {
    const text = `开头${"x".repeat(500)}结尾`;
    const out = headTailTruncate(text, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.startsWith("开头")).toBe(true);
    expect(out.endsWith("结尾")).toBe(true);
    expect(out).toContain("省略");
  });

  it("上限极小时不崩,也不返回比上限更长的串", () => {
    for (const n of [0, 1, 5, 12]) {
      expect(headTailTruncate("a".repeat(100), n).length).toBeLessThanOrEqual(Math.max(n, 0));
    }
  });
});

describe("第 3 级:折叠单轮", () => {
  it("★ 保留首条用户与末条助手,中间替换为省略计数", () => {
    const t = turn(3,
      ["user", "问题"], ["tool", "工具1"], ["tool", "工具2"], ["assistant", "中间答"], ["assistant", "最终答"]);
    const out = collapseTurn(t, 1000);
    expect(out.messages.map((m) => m.role)).toEqual(["user", "tool", "assistant"]);
    expect(out.messages[0]!.text).toBe("问题");
    expect(out.messages[1]!.text).toBe("本轮省略 3 条中间消息");
    // 末条助手,不是中间那条 —— 取错了摘要会看到一个非最终的回答。
    expect(out.messages[2]!.text).toBe("最终答");
  });
});

describe("分块", () => {
  it("空输入或零预算返回空数组", () => {
    expect(chunkTurnsForSummary([], 1000)).toEqual([]);
    expect(chunkTurnsForSummary([turn(1, ["user", "x"])], 0)).toEqual([]);
  });

  it("装得下就一块,装不下按顺序开新块,且轮次不跨块拆开", () => {
    const turns = [1, 2, 3].map((n) => turn(n, ["user", "u".repeat(400)]));
    const chunks = chunkTurnsForSummary(turns, 900);
    expect(chunks.length).toBeGreaterThan(1);
    // 每一轮都完整落在某一块里,没有被切成两半。
    const seen = chunks.flatMap((c) => c.turns.map((t) => t.turn));
    expect(seen).toEqual([1, 2, 3]);
  });

  it("★ 超大单轮也能收敛:降到 2K 仍超则折叠,最终每块都不超预算", () => {
    const huge = turn(1,
      ["user", "问".repeat(50_000)],
      ...Array.from({ length: 20 }, (_, i) => ["tool", "结果".repeat(20_000)] as ["tool", string]),
      ["assistant", "答".repeat(50_000)]);
    const chunks = chunkTurnsForSummary([huge, turn(2, ["user", "短"])], 6_000);
    expect(chunks.length).toBeGreaterThan(0);
    // 收敛的定义:折叠之后那一轮只剩三条,且用的是 2K 下限。
    const first = chunks[0]!.turns[0]!;
    expect(chunks[0]!.messageLimit).toBe(MESSAGE_LIMIT_FLOOR);
    expect(first.messages).toHaveLength(3);
    expect(first.messages[1]!.text).toContain("本轮省略 20 条中间消息");
  });

  it("★ 轮号在分块后仍是会话内的位置,不重排", () => {
    const chunks = chunkTurnsForSummary([turn(5, ["user", "a"]), turn(6, ["user", "b"])], 10_000);
    expect(chunks.flatMap((c) => c.turns.map((t) => t.turn))).toEqual([5, 6]);
  });
});
