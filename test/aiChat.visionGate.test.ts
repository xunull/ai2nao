import { describe, expect, it } from "vitest";
import { visionGate } from "../web/src/aiChat/visionGate";

/**
 * 贴图闸的四态。这组测试守的是**两种「不能」的区别** ——
 * 目录说不行留后门(目录会过期),适配器发不出去不留(那是我们自己依赖的确定事实)。
 * 把它们合成一种,要么用户被永久拦在一个其实能用的模型外,
 * 要么用户为一张根本没送出去的图付钱。
 */
describe("visionGate", () => {
  it("yes → 入口开,不显示条", () => {
    expect(visionGate("yes", false)).toEqual({
      imagesEnabled: true,
      notice: null,
      canForce: false,
    });
  });

  it("★ adapter-no → 入口关,**没有后门**,且文案要说清「发出去也会被丢、费用照扣」", () => {
    const g = visionGate("adapter-no", false);
    expect(g.imagesEnabled).toBe(false);
    expect(g.canForce).toBe(false); // 这一条不给后门
    expect(g.notice).toContain("费用照扣");
  });

  it("★ adapter-no 即使 forced 也不放行 —— 后门按钮压根不该出现在这一态", () => {
    // 万一有别的路径把 forced 置了 true(比如换模型时没收回),
    // 这里必须仍然拦住:适配器发不出去与用户意愿无关。
    const g = visionGate("adapter-no", true);
    expect(g.imagesEnabled).toBe(false);
    expect(g.canForce).toBe(false);
  });

  it("catalog-no → 入口关,但给后门", () => {
    const g = visionGate("catalog-no", false);
    expect(g.imagesEnabled).toBe(false);
    expect(g.canForce).toBe(true);
    expect(g.notice).toContain("不支持读图");
  });

  it("catalog-no + 点过后门 → 入口开,条消失", () => {
    expect(visionGate("catalog-no", true)).toEqual({
      imagesEnabled: true,
      notice: null,
      canForce: false,
    });
  });

  it("★ unknown → 入口**开** + 提示,不是置灰", () => {
    // 目录没拉到/旧缓存/手填的模型。当成「不支持」会让离线时一张图都发不了。
    const g = visionGate("unknown", false);
    expect(g.imagesEnabled).toBe(true);
    expect(g.notice).toContain("没查到");
    expect(g.canForce).toBe(false); // 已经能发了,不需要后门
  });

  it("★ 字段缺失(旧后端)按 unknown,不按不支持", () => {
    // 打包桌面版可能跑的是没有 vision 字段的旧后端。
    expect(visionGate(undefined, false)).toEqual(visionGate("unknown", false));
    expect(visionGate(undefined, false).imagesEnabled).toBe(true);
  });

  it("四态全部覆盖,且只有 catalog-no 一态能被 forced 改变结果", () => {
    const states = ["yes", "unknown", "catalog-no", "adapter-no"] as const;
    const changed = states.filter(
      (s) => visionGate(s, false).imagesEnabled !== visionGate(s, true).imagesEnabled
    );
    expect(changed).toEqual(["catalog-no"]);
  });
});
