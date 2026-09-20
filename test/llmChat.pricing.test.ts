/**
 * 逐笔计价:五档判定与 `partial` 的下限算法。
 *
 * 用自造的价格表而不是 `MODEL_PRICES`:单价取整数,费用可以心算,
 * 断言写的是**确切数字**而不是「大于 0」——后者在算错单价时照样绿。
 */
import { describe, expect, it } from "vitest";
import type { PriceMap } from "../src/cost/pricing.js";
import type { ModelTieredPrice } from "../src/cost/modelCatalog.js";
import { priceChatCall, type ChatCallUsage } from "../src/llmChat/sessions.js";

/** 四个单价刻意各不相同,任意两者用混都会让断言变色。 */
const PRICES: PriceMap = {
  "test-model": { input: 10, output: 100, cacheRead: 1, cacheCreation: 5 },
};

function usage(over: Partial<ChatCallUsage>): ChatCallUsage {
  return {
    input: null,
    noCache: null,
    cacheRead: null,
    cacheWrite: null,
    output: null,
    reasoning: null,
    ...over,
  };
}

describe("priceChatCall —— 五档判定", () => {
  it("unknown:input 与 output 都不知道", () => {
    const r = priceChatCall(usage({ cacheRead: 7 }), "test-model", PRICES);
    expect(r.costState).toBe("unknown");
    expect(r.costUsd).toBeNull();
    expect(r.price).toBeNull();
  });

  it("unknown:连 usage 都没有", () => {
    expect(priceChatCall(null, "test-model", PRICES).costState).toBe("unknown");
  });

  it("unpriced:有用量但这个模型没有价格 —— token 照计,费用留空", () => {
    const r = priceChatCall(usage({ input: 100, output: 10 }), "没见过的模型", PRICES);
    expect(r.costState).toBe("unpriced");
    expect(r.costUsd).toBeNull();
    // 没价格就没有快照可存。
    expect(r.price).toBeNull();
  });

  it("priced:三个输入分桶齐 + output 齐", () => {
    const r = priceChatCall(
      usage({ noCache: 2, cacheRead: 3, cacheWrite: 4, output: 5 }),
      "test-model",
      PRICES
    );
    expect(r.costState).toBe("priced");
    // 2*10 + 3*1 + 4*5 + 5*100 = 20 + 3 + 20 + 500 = 543
    expect(r.costUsd).toBe(543);
  });

  it("priced:分桶缺 noCache,但能由 input 减两个缓存桶反推", () => {
    const r = priceChatCall(
      usage({ input: 9, cacheRead: 3, cacheWrite: 4, output: 5 }),
      "test-model",
      PRICES
    );
    expect(r.costState).toBe("priced");
    // noCache = 9-3-4 = 2 → 与上一条同值。
    expect(r.costUsd).toBe(543);
  });
});

describe("priceChatCall —— 单价快照", () => {
  it("快照记下计价当时的四个单价;cacheWrite 取的是 cacheCreation", () => {
    const r = priceChatCall(
      usage({ noCache: 1, cacheRead: 1, cacheWrite: 1, output: 1 }),
      "test-model",
      PRICES
    );
    // **三套命名在这里汇合,只有这一对名字不同。** 写成 input 或 cacheRead
    // 都不会报错,只会把钱算错 —— 所以单拎出来钉住。
    expect(r.price).toEqual({
      input: 10,
      output: 100,
      cacheRead: 1,
      cacheWrite: 5,
      tier: null,
    });
  });

  it("cacheWrite 用的确实是 cacheCreation 单价,不是别的三个", () => {
    const r = priceChatCall(
      usage({ noCache: 0, cacheRead: 0, cacheWrite: 6, output: 0 }),
      "test-model",
      PRICES
    );
    // 6 * cacheCreation(5) = 30;若误用 input(10) 是 60,误用 cacheRead(1) 是 6。
    expect(r.costUsd).toBe(30);
  });
});

/**
 * 分段价。形状照 volcengine 的 `doubao-seed-2-0-lite` 造:基础价最低,
 * 32k 档更贵,128k 档最贵 —— 真实数据就是这样递增的。
 */
const TIERED: ModelTieredPrice = {
  base: { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 0.5 },
  tiers: [
    { size: 32000, input: 2, output: 20, cacheRead: 0.2, cacheWrite: 1 },
    { size: 128000, input: 4, output: 40, cacheRead: 0.4, cacheWrite: 2 },
  ],
  limit: { context: 256000, output: 131072 },
};

describe("priceChatCall —— 分段价选档", () => {
  const withInput = (input: number) =>
    priceChatCall(
      usage({ input, noCache: input, cacheRead: 0, cacheWrite: 0, output: 1 }),
      "test-model",
      PRICES,
      TIERED
    );

  it("不超过最低档:用基础价,tier 为 null", () => {
    const r = withInput(1000);
    expect(r.costState).toBe("priced");
    // 1000*1 + 1*10 = 1010
    expect(r.costUsd).toBe(1010);
    expect(r.price!.tier).toBeNull();
  });

  it("超过 32k:进第一档", () => {
    const r = withInput(50000);
    // 50000*2 + 1*20 = 100020
    expect(r.costUsd).toBe(100020);
    expect(r.price!.tier).toBe("context:32000");
  });

  it("超过 128k:进**最大**那一档,不是第一个命中的", () => {
    // 这条防的是「从前往后找、遇到第一个就返回」的写法 —— 那样 200000 会
    // 落进 32k 档,单价差一倍,而且不会报错。
    const r = withInput(200000);
    // 200000*4 + 1*40 = 800040
    expect(r.costUsd).toBe(800040);
    expect(r.price!.tier).toBe("context:128000");
  });

  it("边界:恰好等于 size 用下一档更低的那个(判据是「超过」)", () => {
    const r = withInput(32000);
    expect(r.price!.tier).toBeNull();
    expect(r.costUsd).toBe(32010);
  });

  it("档位单价写进快照,cacheWrite 取的是 TierRate.cacheWrite", () => {
    const r = withInput(50000);
    // **两套命名在这里对接**:TierRate 叫 cacheWrite,ModelPrice 叫 cacheCreation。
    expect(r.price).toEqual({
      input: 2,
      output: 20,
      cacheRead: 0.2,
      cacheWrite: 1,
      tier: "context:32000",
    });
  });

  it("不传分段价时行为一字不变 —— 这条是「忘了接」的探测器", () => {
    const withTier = withInput(200000);
    const without = priceChatCall(
      usage({ input: 200000, noCache: 200000, cacheRead: 0, cacheWrite: 0, output: 1 }),
      "test-model",
      PRICES
    );
    // 退回 PRICES 里的 test-model:200000*10 + 1*100 = 2000100
    expect(without.costUsd).toBe(2000100);
    expect(without.price!.tier).toBeNull();
    // 两者必须不同,否则说明分段价根本没生效。
    expect(withTier.costUsd).not.toBe(without.costUsd);
  });

  it("input 未知时按基础价,不瞎猜档位", () => {
    const r = priceChatCall(usage({ output: 5 }), "test-model", PRICES, TIERED);
    // input 为 null → 连 partial 的下限都只能按基础价算,tier 留空。
    expect(r.price!.tier).toBeNull();
  });
});

describe("priceChatCall —— partial 必须是真下限", () => {
  it("output 未知时这部分计 0,不拿别的估", () => {
    // **必须带上 `input`。** 第 2 档 unknown 的判据是「`input` 与 `output` 都为 null」,
    // 而 `input` 是 usage 里的具体字段。只给三个分桶、不给 input,会先被 unknown 截走 ——
    // 而且那种形状不现实:provider 返回的 `inputTokens.total` 就是 input,
    // 三个分桶是它的细分,分桶有值而总数为 null 不会发生。
    const r = priceChatCall(
      usage({ input: 9, noCache: 2, cacheRead: 3, cacheWrite: 4 }),
      "test-model",
      PRICES
    );
    expect(r.costState).toBe("partial");
    // 20 + 3 + 20 = 43,output 一分不算。
    expect(r.costUsd).toBe(43);
  });

  it("输入拆不开时按输入侧最便宜的单价计", () => {
    // 只知道 input 总数与 output,两个缓存桶未知 → 无法拆分。
    const r = priceChatCall(usage({ input: 10, output: 2 }), "test-model", PRICES);
    expect(r.costState).toBe("partial");
    // 最便宜的输入单价是 cacheRead=1 → 10*1 + 2*100 = 210。
    expect(r.costUsd).toBe(210);
  });

  it("★ 下限是真的:补全信息后的精确值必定不低于 partial 的估值", () => {
    // **非空转的关键。** 只断言 partial 算出了某个数,算错单价照样绿;
    // 要证明的是「它确实没高估」——补全同一笔用量的信息,精确值必须更大。
    const partial = priceChatCall(usage({ input: 10, output: 2 }), "test-model", PRICES);
    // 同一笔用量,把分桶补全:全是新鲜输入(最贵的那种)。
    const exact = priceChatCall(
      usage({ input: 10, noCache: 10, cacheRead: 0, cacheWrite: 0, output: 2 }),
      "test-model",
      PRICES
    );
    expect(partial.costState).toBe("partial");
    expect(exact.costState).toBe("priced");
    expect(partial.costUsd!).toBeLessThanOrEqual(exact.costUsd!);
    // 而且是**严格**更小,证明下限不是靠「恰好相等」蒙混过关的。
    expect(partial.costUsd!).toBeLessThan(exact.costUsd!);
  });

  it("★ 下限对缓存桶同样成立:已知桶按实价、未知部分按最便宜", () => {
    // 已知 cacheRead=2,剩下 8 个 input 拆不开。
    const partial = priceChatCall(
      usage({ input: 10, cacheRead: 2, output: 0 }),
      "test-model",
      PRICES
    );
    expect(partial.costState).toBe("partial");
    // 2*1 + (10-2)*1 = 10 —— 剩余按最便宜的 cacheRead 计。
    expect(partial.costUsd).toBe(10);

    // 同一笔用量若剩余其实全是新鲜输入,精确值是 2*1 + 8*10 = 82。
    const exact = priceChatCall(
      usage({ input: 10, noCache: 8, cacheRead: 2, cacheWrite: 0, output: 0 }),
      "test-model",
      PRICES
    );
    expect(exact.costState).toBe("priced");
    expect(partial.costUsd!).toBeLessThan(exact.costUsd!);
  });
});
