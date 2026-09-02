import { describe, expect, it } from "vitest";
import {
  listModelsFromDocument,
  parseLlmChatConfigJson,
  parseLlmChatDocument,
  resolveLlmChatConfig,
  availableProviderList,
  statusModelFields,
  type LlmChatMultiDocument,
} from "../src/llmChat/config.js";

/** 五条模型条目的完整文档,复用给多条用例。 */
function fiveModelDoc(): LlmChatMultiDocument {
  return {
    defaultModelId: "ds-chat",
    keys: { deepseek: "sk-ds", moonshotai: "sk-mo" },
    models: [
      {
        id: "ds-chat",
        label: "DeepSeek Chat",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        baseURL: "https://api.deepseek.com",
        keyRef: "deepseek",
      },
      {
        id: "ds-pro",
        label: "DeepSeek Pro",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        baseURL: "https://api.deepseek.com",
        keyRef: "deepseek",
      },
      {
        id: "kimi-k2",
        label: "Kimi K2",
        provider: "moonshotai",
        model: "kimi-k2",
        baseURL: "https://api.moonshot.ai/v1",
        keyRef: "moonshotai",
      },
      {
        id: "doubao",
        label: "豆包 Pro",
        provider: "volcengine",
        model: "doubao-pro",
        baseURL: "https://ark.cn-beijing.volces.com/api/v3",
        keyRef: "volcengine",
      },
      {
        id: "mm-m2",
        label: "MiniMax M2",
        provider: "minimax",
        model: "MiniMax-M2",
        baseURL: "https://api.minimaxi.com/v1",
        keyRef: "minimax",
      },
    ],
  };
}

describe("parseLlmChatDocument —— 形状保持(写回路径用)", () => {
  it("SC2 防塌缩:五条模型进去,五条出来,逐字段不变", () => {
    const doc = fiveModelDoc();
    const back = parseLlmChatDocument(JSON.stringify(doc));
    // 这条是整个设计的地基:patchCredential 把 parse 的输出写回库
    // (credentialApi.ts `setCredentialRaw(name, JSON.stringify(validated))`),
    // 所以 parse 一旦塌缩成单条,用户每次在设置页保存都会丢掉其余四条。
    expect(back).toEqual(doc);
  });

  it("旧的单模型格式原样穿过,不被改写", () => {
    const legacy = {
      provider: "deepseek",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiKey: "sk-legacy",
    };
    expect(parseLlmChatDocument(JSON.stringify(legacy))).toEqual(legacy);
  });

  it("SC9 拒绝重复 id —— 否则解析结果取决于数组遍历顺序", () => {
    const doc = fiveModelDoc();
    doc.models[1] = { ...doc.models[1], id: "ds-chat" };
    expect(parseLlmChatDocument(JSON.stringify(doc))).toBeNull();
  });

  it("只有 keys 没有 models 也算多模型文档 —— 先填 key 后建条目的顺序不能丢数据", () => {
    const partial = { keys: { deepseek: "sk-ds" } };
    const back = parseLlmChatDocument(JSON.stringify(partial));
    expect(back).toEqual({ defaultModelId: null, keys: { deepseek: "sk-ds" }, models: [] });
  });

  it("非法 JSON 返回 null", () => {
    expect(parseLlmChatDocument("{")).toBeNull();
  });

  it("模型条目缺字段则整份文档非法", () => {
    const doc = fiveModelDoc();
    // @ts-expect-error 故意去掉必填字段
    delete doc.models[0].model;
    expect(parseLlmChatDocument(JSON.stringify(doc))).toBeNull();
  });

  it("未知 provider 的条目让整份文档非法", () => {
    const doc = fiveModelDoc();
    doc.models[0] = { ...doc.models[0], provider: "anthropic" as never };
    expect(parseLlmChatDocument(JSON.stringify(doc))).toBeNull();
  });
});

describe("resolveLlmChatConfig —— 塌缩(6 个下游消费者用)", () => {
  it("SC1 黄金:多模型文档解出来的默认项,与等价的旧单模型配置逐字段相同", () => {
    const legacy = parseLlmChatConfigJson(
      JSON.stringify({
        provider: "deepseek",
        baseURL: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        apiKey: "sk-ds",
      })
    );
    const fromMulti = resolveLlmChatConfig(fiveModelDoc());
    // 每日摘要 / 话题簇命名 / 工作回顾推送 / RAG 兜底四个消费者靠这条不变。
    expect(fromMulti).toEqual(legacy);
  });

  it("旧格式文档原样返回", () => {
    const legacy = parseLlmChatDocument(
      JSON.stringify({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-o" })
    )!;
    expect(resolveLlmChatConfig(legacy)).toEqual({
      provider: "openai",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-o",
    });
  });

  it("SC8 defaultModelId 悬空 → 回落 models[0],不是崩也不是 null", () => {
    const doc = fiveModelDoc();
    doc.defaultModelId = "已经被删掉的条目";
    expect(resolveLlmChatConfig(doc)?.model).toBe("deepseek-v4-flash");
  });

  it("SC8 models 为空 → null(与今天的「未配置」同语义)", () => {
    expect(resolveLlmChatConfig({ defaultModelId: null, keys: {}, models: [] })).toBeNull();
  });

  it("默认项的 keyRef 没有对应 key 时,apiKey 为 undefined 而不是空串", () => {
    const doc = fiveModelDoc();
    doc.defaultModelId = "doubao"; // keys 里没有 volcengine
    expect(resolveLlmChatConfig(doc)?.apiKey).toBeUndefined();
  });
});

describe("listModelsFromDocument —— 可用性判定", () => {
  it("设置页填了 key → available,credentialSource=config", () => {
    const views = listModelsFromDocument(fiveModelDoc(), {});
    const ds = views.find((v) => v.id === "ds-chat")!;
    expect(ds).toMatchObject({ available: true, credentialSource: "config", label: "DeepSeek Chat" });
  });

  it("没填 key 也没环境变量 → 不可用", () => {
    const views = listModelsFromDocument(fiveModelDoc(), {});
    expect(views.find((v) => v.id === "doubao")).toMatchObject({
      available: false,
      credentialSource: "none",
    });
  });

  it("靠环境变量拿 key 的不能被误禁 —— 这是 keySet 谓词的死因", () => {
    const doc = fiveModelDoc();
    delete doc.keys.moonshotai;
    const views = listModelsFromDocument(doc, { MOONSHOT_API_KEY: "sk-env" });
    expect(views.find((v) => v.id === "kimi-k2")).toMatchObject({
      available: true,
      credentialSource: "env",
    });
  });

  it("本地 openai-compatible 端点无需 key,同样不能被误禁", () => {
    const doc: LlmChatMultiDocument = {
      defaultModelId: "lm",
      keys: {},
      models: [
        {
          id: "lm",
          label: "本地 LM Studio",
          provider: "openai-compatible",
          model: "llama3.2",
          baseURL: "http://127.0.0.1:1234/v1",
          keyRef: "lmstudio",
        },
      ],
    };
    expect(listModelsFromDocument(doc, {})[0]).toMatchObject({
      available: true,
      credentialSource: "none-needed",
    });
  });

  it("视图里绝不出现密钥原文", () => {
    const serialized = JSON.stringify(listModelsFromDocument(fiveModelDoc(), {}));
    expect(serialized).not.toContain("sk-ds");
    expect(serialized).not.toContain("sk-mo");
  });

  it("旧格式文档也要合成一条稳定条目 —— 否则老用户升级后 picker 是空的（前置）", () => {
    const legacy = parseLlmChatDocument(
      JSON.stringify({ provider: "deepseek", model: "deepseek-v4-flash", apiKey: "sk-ds" })
    )!;
    const views = listModelsFromDocument(legacy, {});
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ available: true, credentialSource: "config" });
  });
});

describe("status 的模型字段 —— picker / 药丸 / 设置页下拉的唯一数据源", () => {
  it("availableProviders 覆盖全部 provider,并带可预填的 base URL", () => {
    const list = availableProviderList();
    const ids = list.map((p) => p.id).sort();
    // 与 LlmChatProvider 联合类型同源:加一家这里自动出现,前端不用改硬编码清单。
    expect(ids).toEqual([
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
    expect(statusModelFields(fiveModelDoc(), {}).defaultModelId).toBe("ds-chat");
  });

  it("默认悬空时,status 报的是真正会被用的那个(models[0]),不是那个死 id", () => {
    const doc = fiveModelDoc();
    doc.defaultModelId = "已经被删掉的";
    // 药丸显示的必须是实际生效的模型,否则界面又在说谎 —— 这正是 1B 的初衷。
    expect(statusModelFields(doc, {}).defaultModelId).toBe("ds-chat");
  });

  it("旧格式返回合成 id,前端不必特判两种形状", () => {
    const legacy = parseLlmChatDocument(
      JSON.stringify({ provider: "deepseek", model: "deepseek-v4-flash", apiKey: "sk-ds" })
    )!;
    const f = statusModelFields(legacy, {});
    expect(f.models).toHaveLength(1);
    expect(f.defaultModelId).toBe(f.models[0].id);
  });

  it("models 为空时 defaultModelId 是 null,不是编一个", () => {
    expect(statusModelFields({ defaultModelId: "x", keys: {}, models: [] }, {})).toEqual({
      defaultModelId: null,
      models: [],
    });
  });

  it("整个 status 模型字段里不出现任何密钥原文", () => {
    const s = JSON.stringify(statusModelFields(fiveModelDoc(), {}));
    expect(s).not.toContain("sk-ds");
    expect(s).not.toContain("sk-mo");
  });
});
