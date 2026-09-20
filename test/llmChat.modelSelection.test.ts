import { describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/client";
import {
  parseLlmChatDocument,
  selectModelForTurn,
  type LlmChatDocument,
} from "../src/llmChat/config.js";
import { PROVIDER_ADAPTER_CAPABILITIES } from "../src/llmChat/document.js";
import { listModelsFromDocument } from "../src/llmChat/views.js";
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

/**
 * 贴图能力的四态(T7)。四态不是布尔,因为「不能」有两种、处置方式相反:
 * 目录说不行留后门(目录会过期),适配器发不出去不留(那是我们自己的确定事实)。
 */
describe("vision 四态", () => {
  const doc = parseLlmChatDocument(
    JSON.stringify({
      defaultModel: null,
      providers: {
        mm: {
          provider: "minimax",
          label: "MiniMax",
          baseURL: "https://api.minimaxi.com/v1",
          apiKey: "sk-x",
          enabled: true,
          models: [
            { model: "MiniMax-M3", label: "M3" },
            { model: "MiniMax-M2.7", label: "M2.7" },
            { model: "手填的", label: "手填的" },
          ],
        },
        ds: {
          provider: "deepseek",
          label: "DeepSeek",
          baseURL: "https://api.deepseek.com",
          apiKey: "sk-y",
          enabled: true,
          models: [{ model: "deepseek-v4-flash-vision-exp", label: "DS 视觉" }],
        },
      },
    })
  )!;

  /** 模拟 models.dev:M3 能收图,M2.7 不能,手填的那个目录里没有。 */
  const catalog = (_p: string, m: string): "yes" | "no" | "unknown" =>
    m === "MiniMax-M3" || m === "deepseek-v4-flash-vision-exp"
      ? "yes"
      : m === "MiniMax-M2.7"
        ? "no"
        : "unknown";

  const byModel = (env: NodeJS.ProcessEnv = {}) => {
    const out = new Map<string, string>();
    for (const v of listModelsFromDocument(doc, env, catalog)) out.set(v.model, v.vision);
    return out;
  };

  it("目录说能收 + 适配器发得出 → yes", () => {
    expect(byModel().get("MiniMax-M3")).toBe("yes");
  });

  it("目录明确说不收 → catalog-no(界面置灰但留后门)", () => {
    expect(byModel().get("MiniMax-M2.7")).toBe("catalog-no");
  });

  it("★ 目录里没有这个 id(手填的)→ unknown,不是不支持", () => {
    // 把「没查到」当成「不支持」会让手填模型一律不能贴图。
    expect(byModel().get("手填的")).toBe("unknown");
  });

  /**
   * 目前全部适配器都发得出图(见 llmChat.adapterSendsImages.test.ts),`adapter-no`
   * 没有真实的 provider,用改表模拟一家发不出的。无论断言成败都还原。
   */
  const withAdapterDroppingImages = (provider: string, fn: () => void) => {
    const table = PROVIDER_ADAPTER_CAPABILITIES as Record<string, { sendsImages: boolean }>;
    // **存标量,不存对象引用。** 表的每一格现在是对象:存整个引用的话,
    // 改的和"还原"的是同一个对象,还原等于没做,会污染后面的用例。
    const saved = table[provider]!.sendsImages;
    table[provider]!.sendsImages = false;
    try {
      fn();
    } finally {
      table[provider]!.sendsImages = saved;
    }
  };

  it("★ 适配器发不出去 → adapter-no,压过目录的「yes」", () => {
    // 当年 @ai-sdk/deepseek 2.0.35 的 case "user" 里 content 是纯字符串,图无处可去,
    // 而 models.dev 说 deepseek-v4-flash-vision-exp 能收图。
    // 先判适配器就是为了这一条:否则界面显示可贴图,点下去才在后端被拦。
    withAdapterDroppingImages("deepseek", () => {
      expect(byModel().get("deepseek-v4-flash-vision-exp")).toBe("adapter-no");
    });
  });

  it("适配器发得出图时跟着目录走 —— deepseek 升到 2.0.64 后,目录说能收就是 yes", () => {
    expect(byModel().get("deepseek-v4-flash-vision-exp")).toBe("yes");
  });

  it("★ 不传目录时一律 unknown —— 离线/旧缓存不该把所有模型都置灰", () => {
    const out = new Map<string, string>();
    for (const v of listModelsFromDocument(doc, {})) out.set(v.model, v.vision);
    expect(out.get("MiniMax-M3")).toBe("unknown");
    expect(out.get("MiniMax-M2.7")).toBe("unknown");
    expect(out.get("deepseek-v4-flash-vision-exp")).toBe("unknown");
  });

  it("★ 适配器那一态与目录无关 —— 不传目录也照样是确定的 no", () => {
    withAdapterDroppingImages("deepseek", () => {
      const out = new Map<string, string>();
      for (const v of listModelsFromDocument(doc, {})) out.set(v.model, v.vision);
      expect(out.get("deepseek-v4-flash-vision-exp")).toBe("adapter-no");
    });
  });
});
