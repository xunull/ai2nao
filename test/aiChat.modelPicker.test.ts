import { describe, expect, it } from "vitest";
import { assistantModelLabel, resolveChatModel } from "../web/src/aiChat/modelPicker";
import type { LlmChatStatus } from "../web/src/aiChat/types";

function status(over: Partial<LlmChatStatus> = {}): LlmChatStatus {
  return {
    configured: true,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    defaultModelId: "ds",
    models: [
      {
        id: "ds",
        label: "DeepSeek Chat",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        available: true,
        credentialSource: "config",
      },
      {
        id: "kimi",
        label: "Kimi K2",
        provider: "moonshotai",
        model: "kimi-k2",
        available: false,
        credentialSource: "none",
      },
    ],
    availableProviders: [{ id: "deepseek", defaultBaseURL: "https://api.deepseek.com" }],
    baseHost: "api.deepseek.com",
    configPath: "/work/app/llm-chat.json",
    source: "db",
    ...over,
  };
}

describe("resolveChatModel", () => {
  it("没选过时用后端的 defaultModelId —— 不是前端自己挑 models[0]", () => {
    // 后端那个值已经处理过「默认项被删」的回落。前端再挑一次就会两处口径不一致:
    // 药丸说 A、后端用 B。
    const r = resolveChatModel(status({ defaultModelId: "kimi" }), null);
    expect(r.effectiveModelId).toBe("kimi");
    expect(r.selected?.label).toBe("Kimi K2");
  });

  it("选过之后以选择为准", () => {
    expect(resolveChatModel(status(), "kimi").effectiveModelId).toBe("kimi");
  });

  it("status 还没回来时不崩,且不假装选中了谁", () => {
    const r = resolveChatModel(null, null);
    expect(r).toMatchObject({ models: [], effectiveModelId: null, selected: null, fallbackLabel: null });
  });

  it("选中的 id 在列表里找不到时,selected 为 null 而不是回落到第一个", () => {
    // 静默回落正是本次设计一路在拒绝的行为:界面显示 A、实际用 B。
    const r = resolveChatModel(status(), "已经被删掉的");
    expect(r.effectiveModelId).toBe("已经被删掉的");
    expect(r.selected).toBeNull();
    expect(r.fallbackLabel).toBeNull();
  });

  it("一个模型都没配时 effectiveModelId 是 null", () => {
    expect(resolveChatModel(status({ models: [], defaultModelId: null }), null).effectiveModelId).toBeNull();
  });

  it("不可用的模型仍然出现在列表里 —— picker 要置灰而不是隐藏", () => {
    const r = resolveChatModel(status(), null);
    expect(r.models.map((m) => m.id)).toEqual(["ds", "kimi"]);
    expect(r.models.find((m) => m.id === "kimi")?.available).toBe(false);
  });
});

describe("assistantModelLabel", () => {
  it("优先用消息自带的不可变快照", () => {
    const msg = { role: "assistant", ai2naoModel: { modelId: "kimi", label: "Kimi K2" } };
    // 就算 picker 现在选的是别家,这条老消息仍然显示它当时那家。
    expect(assistantModelLabel(msg, "DeepSeek Chat")).toBe("Kimi K2");
  });

  it("快照缺 label 时退到 model 名,而不是直接放弃", () => {
    const msg = { role: "assistant", ai2naoModel: { modelId: "x", model: "kimi-k2" } };
    expect(assistantModelLabel(msg, "DeepSeek Chat")).toBe("kimi-k2");
  });

  it("没有快照(正在流式生成的那条)时用 picker 当前值兜底", () => {
    expect(assistantModelLabel({ role: "assistant" }, "DeepSeek Chat")).toBe("DeepSeek Chat");
  });

  it("既无快照也无兜底时返回 null —— 宁可不显示,也不编一个", () => {
    expect(assistantModelLabel({ role: "assistant" }, null)).toBeNull();
  });

  it("空白快照不算数", () => {
    const msg = { role: "assistant", ai2naoModel: { label: "   " } };
    expect(assistantModelLabel(msg, "DeepSeek Chat")).toBe("DeepSeek Chat");
  });

  it("消息不是对象时不抛", () => {
    expect(assistantModelLabel(null, "X")).toBe("X");
    expect(assistantModelLabel("字符串", null)).toBeNull();
  });
});
