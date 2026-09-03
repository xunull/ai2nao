import { describe, expect, it } from "vitest";
import {
  encodeModelViewId,
  decodeModelViewId,
  parseLlmChatDocument,
  type LlmChatDocument,
} from "../src/llmChat/document.js";

/**
 * 新形状:厂商为一等公民。
 *
 * `parseLlmChatDocument` **始终归一到这个形状** —— 三种历史形状进来,一种形状出去。
 * 这与初稿的「形状保持」相反,理由是决定性的:`redactLlmChat` 只回 presence 布尔,
 * 前端手上根本没有密钥原文,搬不动它;而 `patchCredential` 把 parse 的输出写回库,
 * 所以搬运只能发生在这里。
 */

const FLAT = {
  defaultModelId: "model-1",
  keys: { deepseek: "sk-ds", minimax: "sk-mm" },
  models: [
    {
      id: "legacy",
      label: "DeepSeek Chat",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseURL: "https://api.deepseek.com",
      keyRef: "deepseek",
    },
    {
      id: "model-1",
      label: "MiniMax M2",
      provider: "minimax",
      model: "MiniMax-M2",
      baseURL: "https://api.minimaxi.com/v1",
      keyRef: "minimax",
    },
  ],
};

function parse(doc: unknown): LlmChatDocument {
  const out = parseLlmChatDocument(JSON.stringify(doc));
  expect(out).not.toBeNull();
  return out as LlmChatDocument;
}

describe("视图 id 的编解码", () => {
  it("按第一个冒号切 —— 模型名可以含冒号(ollama 的 qwen:7b)", () => {
    const id = encodeModelViewId("local", "qwen:7b");
    expect(decodeModelViewId(id)).toEqual({ providerId: "local", model: "qwen:7b" });
  });

  it("实例 id 含冒号时消毒保留,不是拒绝整份文档", () => {
    // 拒绝 = parse 返回 null = 下一次保存把整库清成 patch(见 S1b 那组)。
    // 冒号只是让编码不可逆,消毒掉即可,密钥一把都不能因此丢。
    const doc = parse({
      providers: { "a:b": { provider: "deepseek", baseURL: "https://x.invalid", apiKey: "sk-不能丢", models: [] } },
    });
    const ids = Object.keys(doc.providers);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toContain(":");
    expect(doc.providers[ids[0]].apiKey).toBe("sk-不能丢");
  });

  it("没有冒号的 id 解不出来,返回 null 而不是猜", () => {
    expect(decodeModelViewId("没有冒号")).toBeNull();
  });
});

describe("parseLlmChatDocument —— 三形状归一", () => {
  it("旧单模型 → 一个实例,顶层 apiKey 搬进去", () => {
    const doc = parse({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseURL: "https://api.deepseek.com",
      apiKey: "sk-老配置",
    });
    const ids = Object.keys(doc.providers);
    expect(ids).toHaveLength(1);
    const inst = doc.providers[ids[0]];
    expect(inst.apiKey).toBe("sk-老配置");
    expect(inst.models).toEqual([{ model: "deepseek-v4-flash", label: "deepseek-v4-flash" }]);
    expect(doc.defaultModel).toEqual({ providerId: ids[0], model: "deepseek-v4-flash" });
  });

  it("扁平形状 → 按 keyRef 分组,每把 key 搬进对应实例", () => {
    const doc = parse(FLAT);
    expect(Object.keys(doc.providers).sort()).toEqual(["deepseek", "minimax"]);
    expect(doc.providers.deepseek.apiKey).toBe("sk-ds");
    expect(doc.providers.minimax.apiKey).toBe("sk-mm");
  });

  it("★ 模型的 label 不丢 —— 它是用户可编辑字段,还会盖进消息快照", () => {
    const doc = parse(FLAT);
    expect(doc.providers.deepseek.models).toEqual([
      { model: "deepseek-v4-flash", label: "DeepSeek Chat" },
    ]);
  });

  it("★ defaultModelId 翻译成 defaultModel —— fixture 刻意不指向第一条", () => {
    // 指向 model-1(第二条)。若翻译时图省事取 models[0],这条会红。
    expect(parse(FLAT).defaultModel).toEqual({ providerId: "minimax", model: "MiniMax-M2" });
  });

  it("★ 孤儿 key(无任何模型引用)也要有归属实例", () => {
    const doc = parse({ ...FLAT, keys: { ...FLAT.keys, moonshotai: "sk-孤儿" } });
    expect(doc.providers.moonshotai?.apiKey).toBe("sk-孤儿");
    expect(doc.providers.moonshotai?.models).toEqual([]);
  });

  it("★ keyRef 不是合法 provider 的孤儿 key,宁可落成待修实例也不丢", () => {
    const doc = parse({ defaultModelId: null, keys: { "我随手写的": "sk-不能丢" }, models: [] });
    const inst = Object.values(doc.providers).find((p) => p.apiKey === "sk-不能丢");
    expect(inst).toBeDefined();
    expect(inst!.provider).toBe("openai-compatible");
  });

  it("★ 同 keyRef 但 baseURL 不同 → 两个实例,不静默合并", () => {
    const doc = parse({
      defaultModelId: "a",
      keys: { deepseek: "sk-ds" },
      models: [
        { id: "a", label: "官方", provider: "deepseek", model: "m1", baseURL: "https://api.deepseek.com", keyRef: "deepseek" },
        { id: "b", label: "代理", provider: "deepseek", model: "m2", baseURL: "https://proxy.invalid/v1", keyRef: "deepseek" },
      ],
    });
    const insts = Object.values(doc.providers);
    expect(insts).toHaveLength(2);
    expect(new Set(insts.map((i) => i.baseURL)).size).toBe(2);
    // 两个实例共用同一把 key —— 一把都不能丢。
    expect(insts.every((i) => i.apiKey === "sk-ds")).toBe(true);
  });

  it("★ 迁移出来的实例名用 provider,不是 keyRef —— 否则左栏会出现一个叫「legacy」的厂商", () => {
    // 老库里旧单模型的槽位就叫 legacy(真实数据,不是假设)。拿它当显示名,
    // 用户在设置页看到的是一个名叫「legacy」的服务商,不知道那是哪家。
    const doc = parse({
      defaultModelId: "legacy",
      keys: { legacy: "sk-老的" },
      models: [
        { id: "legacy", label: "DeepSeek deepseek-reasoner", provider: "deepseek", model: "deepseek-reasoner", baseURL: "https://api.deepseek.com", keyRef: "legacy" },
      ],
    });
    // 实例 id 仍是 legacy(内部引用不受影响),但显示名是 provider。
    expect(doc.providers.legacy.label).toBe("deepseek");
    expect(doc.providers.legacy.apiKey).toBe("sk-老的");
    // 模型自己的 label 是用户数据,原样保留。
    expect(doc.providers.legacy.models[0].label).toBe("DeepSeek deepseek-reasoner");
  });

  it("新形状进来原样出去(幂等)", () => {
    const once = parse(FLAT);
    const twice = parse(once);
    expect(twice).toEqual(once);
  });

  it("enabled 缺省为 true —— 老文档没有这个字段", () => {
    expect(parse(FLAT).providers.deepseek.enabled).toBe(true);
    const off = parse({
      providers: { x: { provider: "deepseek", baseURL: "https://api.deepseek.com", enabled: false, models: [] } },
    });
    expect(off.providers.x.enabled).toBe(false);
  });

  it("旧的三个字段不再出现在输出里 —— 归一之后它们没有位置", () => {
    const doc = parse(FLAT) as unknown as Record<string, unknown>;
    expect("models" in doc).toBe(false);
    expect("keys" in doc).toBe(false);
    expect("defaultModelId" in doc).toBe(false);
  });

  it("只有结构性不可解析才返回 null —— 内容问题一律降级处理", () => {
    expect(parseLlmChatDocument("{")).toBeNull();
    expect(parseLlmChatDocument("[]")).toBeNull();
    expect(parseLlmChatDocument('"字符串"')).toBeNull();
    // 而「providers 里全是坏实例」不是结构问题:返回一份空文档,让写回不至于清库。
    const empty = parse({ providers: { x: { provider: "不存在", baseURL: "y", models: [] } } });
    expect(empty.providers).toEqual({});
  });
});

describe("★ parse 的宽容度 —— 严格失败在写回管道里是破坏装置", () => {
  /**
   * credentialApi.ts:133 取 base = spec.parse(stored);null 时 mergePatch(null, patch)
   * 走 :107 的 isPlainObject(base) ? {...base} : {} → 空对象 → setCredentialRaw
   * **只写下这次 patch,库里其余厂商连密钥一起消失**。
   * 所以坏条目必须跳过并保留其余,不能一条坏就整份 null。
   */
  it("一条坏模型不该让整个实例作废", () => {
    const doc = parse({
      providers: {
        deepseek: {
          provider: "deepseek",
          baseURL: "https://api.deepseek.com",
          apiKey: "sk-ds",
          models: [{ model: "good" }, { nope: 1 }, { model: "also-good" }],
        },
      },
    });
    expect(doc.providers.deepseek.models.map((m) => m.model)).toEqual(["good", "also-good"]);
    expect(doc.providers.deepseek.apiKey).toBe("sk-ds");
  });

  it("一个坏实例不该让其余实例连密钥一起消失", () => {
    const doc = parse({
      providers: {
        deepseek: { provider: "deepseek", baseURL: "https://api.deepseek.com", apiKey: "sk-活着", models: [] },
        坏的: { provider: "根本不存在的厂商", baseURL: "x", models: [] },
      },
    });
    expect(doc.providers.deepseek.apiKey).toBe("sk-活着");
    expect(doc.providers["坏的"]).toBeUndefined();
  });

  it("默认指向一个不存在的模型时,defaultModel 置 null 而不是让整份文档作废", () => {
    const doc = parse({
      defaultModel: { providerId: "deepseek", model: "已经删掉的" },
      providers: { deepseek: { provider: "deepseek", baseURL: "https://api.deepseek.com", models: [{ model: "m1" }] } },
    });
    expect(doc.defaultModel).toBeNull();
    expect(doc.providers.deepseek.models).toHaveLength(1);
  });
});
