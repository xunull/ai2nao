import { describe, expect, it } from "vitest";
import {
  availableProviderList,
  listModelsFromDocument,
  listProvidersFromDocument,
  parseLlmChatDocument,
  resolveLlmChatConfig,
  statusModelFields,
  type LlmChatDocument,
} from "../src/llmChat/config.js";

/**
 * 五条模型的**旧扁平文档**。保留旧形状是有意的:它同时是迁移用例 ——
 * 每条断言都顺带证明「老用户的库读进来不丢东西」。
 */
function fiveModelRaw() {
  return {
    defaultModelId: "ds-chat",
    keys: { deepseek: "sk-ds", moonshotai: "sk-mo" },
    models: [
      { id: "ds-chat", label: "DeepSeek Chat", provider: "deepseek", model: "deepseek-v4-flash", baseURL: "https://api.deepseek.com", keyRef: "deepseek" },
      { id: "ds-pro", label: "DeepSeek Pro", provider: "deepseek", model: "deepseek-v4-pro", baseURL: "https://api.deepseek.com", keyRef: "deepseek" },
      { id: "kimi-k2", label: "Kimi K2", provider: "moonshotai", model: "kimi-k2", baseURL: "https://api.moonshot.ai/v1", keyRef: "moonshotai" },
      { id: "doubao", label: "豆包 Pro", provider: "volcengine", model: "doubao-pro", baseURL: "https://ark.cn-beijing.volces.com/api/v3", keyRef: "volcengine" },
      { id: "mm-m2", label: "MiniMax M2", provider: "minimax", model: "MiniMax-M2", baseURL: "https://api.minimaxi.com/v1", keyRef: "minimax" },
    ],
  };
}

function parse(raw: unknown): LlmChatDocument {
  const doc = parseLlmChatDocument(JSON.stringify(raw));
  expect(doc).not.toBeNull();
  return doc as LlmChatDocument;
}

/** 五条模型 → 四个实例(deepseek 那两条同 keyRef 同 baseURL,归一个)。 */
function fiveModelDoc(): LlmChatDocument {
  return parse(fiveModelRaw());
}

const LEGACY_RAW = { provider: "deepseek", model: "deepseek-v4-flash", apiKey: "sk-ds" };

describe("parseLlmChatDocument —— 归一(写回路径用)", () => {
  it("SC2 防塌缩:五条模型进去,五条出来,逐字段不变", () => {
    const doc = fiveModelDoc();
    const flat = Object.values(doc.providers).flatMap((p) => p.models);
    expect(flat).toHaveLength(5);
    expect(flat.map((m) => m.model).sort()).toEqual(
      ["MiniMax-M2", "deepseek-v4-flash", "deepseek-v4-pro", "doubao-pro", "kimi-k2"]
    );
    // label 是用户可编辑字段,还会盖进消息快照 —— 归一时一个都不能掉。
    expect(flat.map((m) => m.label).sort()).toEqual(
      ["DeepSeek Chat", "DeepSeek Pro", "Kimi K2", "MiniMax M2", "豆包 Pro"]
    );
  });

  it("同一实例下的多条模型不被合并 —— deepseek 那两条共用 key,但是两条", () => {
    expect(fiveModelDoc().providers.deepseek.models).toHaveLength(2);
  });

  it("只有 keys 没有 models 也不丢数据 —— 先填 key 后建条目的顺序必须成立", () => {
    const doc = parse({ defaultModelId: null, keys: { deepseek: "sk-x" }, models: [] });
    expect(doc.providers.deepseek.apiKey).toBe("sk-x");
    expect(doc.providers.deepseek.models).toEqual([]);
  });

  it("从旧格式升级时不吞掉那把老 key —— mergePatch 会把它带进来", () => {
    // 用户把旧单模型升级成多模型时,PATCH 体里仍带着顶层 apiKey。
    // 丢掉它 = 用户没当场重输就永久丢 key,而前端拿不到原文补不回来。
    const doc = parse({ apiKey: "sk-老的", defaultModelId: null, keys: {}, models: [] });
    const kept = Object.values(doc.providers).some((p) => p.apiKey === "sk-老的");
    expect(kept).toBe(true);
  });

  it("keys 里已经有同名槽位时,不被顶层 apiKey 覆盖", () => {
    const doc = parse({ apiKey: "sk-顶层", defaultModelId: null, keys: { legacy: "sk-已存" }, models: [] });
    const secrets = Object.values(doc.providers).map((p) => p.apiKey);
    expect(secrets).toContain("sk-已存");
    // 顶层那把只在没人占坑时才落地;既有槽位优先,否则一次保存就覆盖掉真的那把。
    expect(secrets.filter((s) => s === "sk-已存")).toHaveLength(1);
  });

  it("★ 坏条目降级而不是让整份文档非法 —— 严格失败在写回管道里是破坏装置", () => {
    // 这里与改造前的语义**相反**,是刻意的:旧实现对「缺字段 / 未知 provider」
    // 返回 null,而 credentialApi.ts:133 拿 null 去 mergePatch 会退化成空对象,
    // 下一次保存把库里其余厂商连密钥一起清掉。宁可丢一条坏条目,不能丢一库 key。
    const doc = parse({
      defaultModelId: null,
      keys: { deepseek: "sk-活着" },
      models: [
        { id: "good", label: "好的", provider: "deepseek", model: "m1", baseURL: "https://api.deepseek.com", keyRef: "deepseek" },
        { id: "缺字段" },
        { id: "坏厂商", provider: "根本不存在", model: "m2", keyRef: "deepseek" },
      ],
    });
    expect(doc.providers.deepseek.apiKey).toBe("sk-活着");
    expect(doc.providers.deepseek.models).toEqual([{ model: "m1", label: "好的" }]);
  });

  it("非法 JSON 返回 null", () => {
    expect(parseLlmChatDocument("{")).toBeNull();
  });
});

describe("resolveLlmChatConfig —— 塌缩(6 个下游消费者用)", () => {
  it("SC1 黄金:多模型文档解出来的默认项,与等价的旧单模型配置逐字段相同", () => {
    const fromMulti = resolveLlmChatConfig(fiveModelDoc());
    const fromLegacy = resolveLlmChatConfig(parse(LEGACY_RAW));
    expect(fromMulti).toEqual(fromLegacy);
    expect(fromMulti).toEqual({
      provider: "deepseek",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiKey: "sk-ds",
    });
  });

  it("SC8 默认项悬空 → 回落第一条,不是崩也不是 null", () => {
    const doc = fiveModelDoc();
    doc.defaultModel = { providerId: "deepseek", model: "已经被删掉的" };
    expect(resolveLlmChatConfig(doc)?.model).toBe("deepseek-v4-flash");
  });

  it("空文档 → null(与今天的「未配置」同语义)", () => {
    expect(resolveLlmChatConfig({ defaultModel: null, providers: {} })).toBeNull();
  });

  it("实例没有 key 时,apiKey 为 undefined 而不是空串", () => {
    // 空串会让下游 `cfg.apiKey || env` 短路失败之外还多一种状态;undefined 才让
    // model.ts 的 env 兜底正常接手。
    const doc = fiveModelDoc();
    doc.defaultModel = { providerId: "volcengine", model: "doubao-pro" };
    expect(resolveLlmChatConfig(doc)?.apiKey).toBeUndefined();
  });

  it("★ 默认实例被关掉 → null,不静默换成另一家", () => {
    // 关开关的意图是「别用这家」。静默回落 = 每日摘要/RAG 不知不觉换了模型、
    // 还在花另一家的钱。宁可停,也不能悄悄换。
    const doc = fiveModelDoc();
    doc.providers.deepseek.enabled = false;
    expect(resolveLlmChatConfig(doc)).toBeNull();
  });
});

describe("listModelsFromDocument —— 可用性判定", () => {
  it("设置页填了 key → available,credentialSource=config", () => {
    const ds = listModelsFromDocument(fiveModelDoc(), {}).find((v) => v.model === "deepseek-v4-flash")!;
    expect(ds).toMatchObject({ available: true, credentialSource: "config", label: "DeepSeek Chat" });
  });

  it("没填 key 也没环境变量 → 不可用", () => {
    const views = listModelsFromDocument(fiveModelDoc(), {});
    expect(views.find((v) => v.model === "doubao-pro")).toMatchObject({
      available: false,
      credentialSource: "none",
    });
  });

  it("靠环境变量拿 key 的不能被误禁 —— 这是 keySet 谓词的死因", () => {
    const raw = fiveModelRaw();
    delete (raw.keys as Record<string, string>).moonshotai;
    const views = listModelsFromDocument(parse(raw), { MOONSHOT_API_KEY: "sk-env" });
    expect(views.find((v) => v.model === "kimi-k2")).toMatchObject({
      available: true,
      credentialSource: "env",
    });
  });

  it("本地 openai-compatible 端点无需 key,同样不能被误禁", () => {
    const doc = parse({
      providers: {
        lm: {
          provider: "openai-compatible",
          label: "本地 LM Studio",
          baseURL: "http://127.0.0.1:1234/v1",
          models: [{ model: "llama3.2" }],
        },
      },
    });
    expect(listModelsFromDocument(doc, {})[0]).toMatchObject({
      available: true,
      credentialSource: "none-needed",
    });
  });

  it("★ 已关闭的实例整个不出现在 picker 里,而不是置灰", () => {
    // 置灰的含义是「配置不全,去补」;关掉的含义是「别用这家」。两者不能混。
    const doc = fiveModelDoc();
    doc.providers.deepseek.enabled = false;
    const views = listModelsFromDocument(doc, {});
    expect(views).toHaveLength(3);
    expect(views.some((v) => v.provider === "deepseek")).toBe(false);
  });

  it("视图里绝不出现密钥原文", () => {
    const serialized = JSON.stringify(listModelsFromDocument(fiveModelDoc(), {}));
    expect(serialized).not.toContain("sk-ds");
    expect(serialized).not.toContain("sk-mo");
  });

  it("旧格式文档也要合成一条稳定条目 —— 否则老用户升级后 picker 是空的", () => {
    const views = listModelsFromDocument(parse(LEGACY_RAW), {});
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ available: true, credentialSource: "config" });
  });
});

describe("listProvidersFromDocument —— 厂商列的数据源", () => {
  it("★ 含 0 模型的实例 —— 刚粘上 key 还没选模型的那一秒不能从左栏消失", () => {
    const doc = parse({ defaultModelId: null, keys: { deepseek: "sk-x" }, models: [] });
    const list = listProvidersFromDocument(doc, {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ modelCount: 0, credentialSource: "config", enabled: true });
  });

  it("★ 含已关闭的实例 —— 关掉之后还得看得见才能重新打开", () => {
    const doc = fiveModelDoc();
    doc.providers.deepseek.enabled = false;
    const list = listProvidersFromDocument(doc, {});
    expect(list).toHaveLength(4);
    expect(list.find((p) => p.id === "deepseek")).toMatchObject({ enabled: false, modelCount: 2 });
  });

  it("不出现密钥原文", () => {
    expect(JSON.stringify(listProvidersFromDocument(fiveModelDoc(), {}))).not.toContain("sk-ds");
  });
});

describe("status 的模型字段 —— picker / 药丸 / 设置页下拉的唯一数据源", () => {
  it("availableProviders 覆盖全部 provider,并带可预填的 base URL", () => {
    const list = availableProviderList();
    // 与 LlmChatProvider 联合类型同源:加一家这里自动出现,前端不用改硬编码清单。
    expect(list.map((p) => p.id).sort()).toEqual([
      "alibaba",
      "deepseek",
      "minimax",
      "moonshotai",
      "openai",
      "openai-compatible",
      "volcengine",
    ]);
    expect(list.find((p) => p.id === "volcengine")?.defaultBaseURL).toBe(
      "https://ark.cn-beijing.volces.com/api/v3"
    );
    // openai-compatible 没有默认地址(必须用户自己填),空串是有意的。
    expect(list.find((p) => p.id === "openai-compatible")?.defaultBaseURL).toBe("");
  });

  it("defaultModelId 如实反映当前默认项", () => {
    expect(statusModelFields(fiveModelDoc(), {}).defaultModelId).toBe("deepseek:deepseek-v4-flash");
  });

  it("默认悬空时,status 报的是真正会被用的那个,不是那个死 id", () => {
    const doc = fiveModelDoc();
    doc.defaultModel = { providerId: "deepseek", model: "已经被删掉的" };
    // 药丸显示的必须是实际生效的模型,否则界面又在说谎 —— 这正是 1B 的初衷。
    expect(statusModelFields(doc, {}).defaultModelId).toBe("deepseek:deepseek-v4-flash");
  });

  it("★ 默认实例被关掉时 defaultDisabled 为 true —— 后台四个功能会停,得说出来", () => {
    const doc = fiveModelDoc();
    doc.providers.deepseek.enabled = false;
    const f = statusModelFields(doc, {});
    expect(f.defaultDisabled).toBe(true);
    // 而 picker 仍有别家可选 —— 「默认停了」与「没得用」是两回事。
    expect(f.models.length).toBeGreaterThan(0);
  });

  it("旧格式返回合成 id,前端不必特判两种形状", () => {
    const f = statusModelFields(parse(LEGACY_RAW), {});
    expect(f.models).toHaveLength(1);
    expect(f.defaultModelId).toBe(f.models[0].id);
  });

  it("没有模型时 defaultModelId 是 null,不是编一个", () => {
    const f = statusModelFields({ defaultModel: null, providers: {} }, {});
    expect(f.defaultModelId).toBeNull();
    expect(f.models).toEqual([]);
    expect(f.providers).toEqual([]);
    expect(f.defaultDisabled).toBe(false);
  });

  it("整个 status 模型字段里不出现任何密钥原文", () => {
    const s = JSON.stringify(statusModelFields(fiveModelDoc(), {}));
    expect(s).not.toContain("sk-ds");
    expect(s).not.toContain("sk-mo");
  });
});
