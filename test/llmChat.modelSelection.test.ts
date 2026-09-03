import { describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/client";
import {
  parseLlmChatDocument,
  selectModelForTurn,
  type LlmChatDocument,
} from "../src/llmChat/config.js";
import { stampModelSnapshot } from "../src/llmChat/modelStamp.js";
import { parseForwardedToolProps } from "../src/llmTools/forwardedProps.js";

/** 旧扁平形状喂进 parse —— fixture 本身兼作迁移用例。 */
function doc(): LlmChatDocument {
  return parseLlmChatDocument(
    JSON.stringify({
      defaultModelId: "ds-chat",
      keys: { deepseek: "sk-ds" },
      models: [
        { id: "ds-chat", label: "DeepSeek Chat", provider: "deepseek", model: "deepseek-v4-flash", baseURL: "https://api.deepseek.com", keyRef: "deepseek" },
        { id: "kimi-k2", label: "Kimi K2", provider: "moonshotai", model: "kimi-k2", baseURL: "https://api.moonshot.ai/v1", keyRef: "moonshotai" }, // keys 里没有 → 不可用
      ],
    })
  ) as LlmChatDocument;
}

const DS = "deepseek:deepseek-v4-flash";
const KIMI = "moonshotai:kimi-k2";

describe("forwardedProps.modelId —— 前端传来的值不可信", () => {
  it("合法字符串被收下", () => {
    expect(parseForwardedToolProps({ modelId: "kimi-k2" }).modelId).toBe("kimi-k2");
  });

  it("缺失 / 空串 / 非字符串一律归为 null,由后端决定用默认", () => {
    expect(parseForwardedToolProps({}).modelId).toBeNull();
    expect(parseForwardedToolProps({ modelId: "   " }).modelId).toBeNull();
    expect(parseForwardedToolProps({ modelId: 42 }).modelId).toBeNull();
    expect(parseForwardedToolProps({ modelId: null }).modelId).toBeNull();
  });

  it("加了 modelId 不影响原有的工具开关解析", () => {
    const p = parseForwardedToolProps({ modelId: "x", webSearchEnabled: true, ragTopK: 3 });
    expect(p.webSearchEnabled).toBe(true);
    expect(p.ragTopK).toBe(3);
  });
});

describe("selectModelForTurn", () => {
  it("modelId 为 null → 用默认项", () => {
    const r = selectModelForTurn(doc(), null, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.model).toBe("deepseek-v4-flash");
      expect(r.snapshot).toEqual({
        modelId: DS,
        provider: "deepseek",
        model: "deepseek-v4-flash",
        label: "DeepSeek Chat",
      });
    }
  });

  it("SC7 未知 modelId → 报错,**不**静默回落默认", () => {
    const r = selectModelForTurn(doc(), "根本不存在", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown-model");
  });

  it("SC7 选中的模型没配 key → 报错,且错误文案里有模型名", () => {
    const r = selectModelForTurn(doc(), KIMI, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unavailable");
      expect(r.message).toContain("Kimi K2");
    }
  });

  it("靠环境变量拿 key 的选得中 —— 与 picker 的可用性判定同源", () => {
    const r = selectModelForTurn(doc(), KIMI, { MOONSHOT_API_KEY: "sk-env" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.snapshot.modelId).toBe(KIMI);
  });

  it("库里没有任何配置 → not-configured(与今天「未配置」同语义)", () => {
    const r = selectModelForTurn(null, null, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-configured");
  });

  it("默认项自己不可用时也报错 —— 不能因为它是默认就放行", () => {
    const d = doc();
    d.defaultModel = { providerId: "moonshotai", model: "kimi-k2" };
    delete d.providers.deepseek.apiKey;
    const r = selectModelForTurn(d, null, {});
    expect(r.ok).toBe(false);
  });

  it("★ 选中已关闭实例下的模型 → 报错,理由是 disabled 而不是含糊的不可用", () => {
    // 运行路径不经过 listModelsFromDocument:forwardedProps 原样透传 modelId,
    // 只测视图函数把已关闭的过滤掉,等于没测这条路。
    const d = doc();
    d.providers.deepseek.enabled = false;
    const r = selectModelForTurn(d, DS, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("disabled");
  });

  it("旧单模型格式仍可用,快照带合成 id", () => {
    const legacy = parseLlmChatDocument(
      JSON.stringify({ provider: "deepseek", model: "deepseek-v4-flash", apiKey: "sk-ds" })
    )!;
    const r = selectModelForTurn(legacy, null, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.snapshot.model).toBe("deepseek-v4-flash");
  });
});

describe("stampModelSnapshot —— 不可变快照,不是可变外键", () => {
  const snap = {
    modelId: "ds-chat",
    provider: "deepseek" as const,
    model: "deepseek-v4-flash",
    label: "DeepSeek Chat",
  };

  it("assistant 消息盖上快照", () => {
    const out = stampModelSnapshot(
      [{ id: "a", role: "assistant", content: "hi" } as Message],
      snap
    );
    expect((out[0] as { ai2naoModel?: unknown }).ai2naoModel).toEqual(snap);
  });

  it("user 与 tool 消息不盖 —— 它们不是模型产出的", () => {
    const out = stampModelSnapshot(
      [
        { id: "u", role: "user", content: "q" } as Message,
        { id: "t", role: "tool", toolCallId: "c", content: "r" } as Message,
      ],
      snap
    );
    for (const m of out) expect((m as { ai2naoModel?: unknown }).ai2naoModel).toBeUndefined();
  });

  it("原有字段一个不丢 —— raw_json 存的是整条消息", () => {
    const out = stampModelSnapshot(
      [{ id: "a", role: "assistant", content: "hi", toolCalls: [] } as unknown as Message],
      snap
    );
    expect(out[0]).toMatchObject({ id: "a", role: "assistant", content: "hi", toolCalls: [] });
  });

  it("已经盖过的不覆盖 —— 历史消息保留它当时那一家", () => {
    const older = { ...snap, modelId: "kimi-k2", label: "Kimi K2" };
    const out = stampModelSnapshot(
      [{ id: "a", role: "assistant", content: "hi", ai2naoModel: older } as unknown as Message],
      snap
    );
    expect((out[0] as { ai2naoModel?: unknown }).ai2naoModel).toEqual(older);
  });

  it("不改原数组,返回新对象", () => {
    const input = [{ id: "a", role: "assistant", content: "hi" } as Message];
    const out = stampModelSnapshot(input, snap);
    expect((input[0] as { ai2naoModel?: unknown }).ai2naoModel).toBeUndefined();
    expect(out[0]).not.toBe(input[0]);
  });
});
