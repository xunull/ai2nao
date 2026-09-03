import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_SPECS,
  OBJECT_SECRET_FIELDS,
  STRING_SECRET_FIELDS,
} from "../src/settings/schema.js";
import { mergePatch } from "../src/settings/credentialApi.js";

/**
 * `credentialApi.ts` 把 `spec.redact(parsed)` 的结果直接放进返回给前端的 DTO,
 * 而 `schema.ts` 的 `omit()` 是浅删(只删顶层键)。存储形状一改,脱敏就可能开天窗。
 *
 * 现有 `settings.routes.test.ts:136` 确实守着这件事,但它喂的是**顶层 apiKey**;
 * 新的 `keys{}` 形状对那条断言是一张空网 —— 它会照样绿。这个文件补的就是那张网。
 */
const spec = CREDENTIAL_SPECS["llm-chat"];

describe("llm-chat 凭据脱敏", () => {
  it("新形状:keys 里的每一把 key 都不出现在脱敏结果里", () => {
    const parsed = spec.parse(
      JSON.stringify({
        defaultModelId: "ds",
        keys: { deepseek: "sk-DEEP-SECRET", moonshotai: "sk-MOON-SECRET" },
        models: [
          {
            id: "ds",
            label: "DeepSeek",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            baseURL: "https://api.deepseek.com",
            keyRef: "deepseek",
          },
        ],
      })
    );
    expect(parsed).not.toBeNull();
    const serialized = JSON.stringify(spec.redact(parsed));
    expect(serialized).not.toContain("sk-DEEP-SECRET");
    expect(serialized).not.toContain("sk-MOON-SECRET");
  });

  it("旧形状:顶层 apiKey 同样不出现 —— secretFields 只写 ['keys'] 会漏掉这条", () => {
    const parsed = spec.parse(
      JSON.stringify({
        provider: "deepseek",
        model: "deepseek-v4-flash",
        apiKey: "sk-LEGACY-SECRET",
      })
    );
    expect(parsed).not.toBeNull();
    expect(JSON.stringify(spec.redact(parsed))).not.toContain("sk-LEGACY-SECRET");
  });

  it("脱敏后 UI 仍能看出哪家配了 key(每个实例一个 hasKey,不是整块抹掉)", () => {
    const parsed = spec.parse(
      JSON.stringify({
        providers: {
          deepseek: { provider: "deepseek", baseURL: "https://api.deepseek.com", apiKey: "sk-x", models: [] },
          moonshotai: { provider: "moonshotai", baseURL: "https://api.moonshot.ai/v1", apiKey: "", models: [] },
        },
      })
    );
    const redacted = spec.redact(parsed) as {
      providers: Record<string, { hasKey: boolean; apiKey?: string }>;
    };
    expect(redacted.providers.deepseek.hasKey).toBe(true);
    expect(redacted.providers.moonshotai.hasKey).toBe(false);
    // 明文字段本身必须消失,不是「也一起返回」。
    expect("apiKey" in redacted.providers.deepseek).toBe(false);
  });

  it("★ 密钥藏在 providers 里嵌套一层 —— 浅 omit 够不着,必须深走", () => {
    // 这条是形状改动引入的真实开天窗风险:顶层 omit(["apiKey","keys"]) 对
    // providers.x.apiKey 完全无效,于是每一把 key 明文直送浏览器。
    const parsed = spec.parse(
      JSON.stringify({
        providers: {
          a: { provider: "deepseek", baseURL: "https://api.deepseek.com", apiKey: "sk-NESTED-SECRET", models: [] },
        },
      })
    );
    expect(JSON.stringify(spec.redact(parsed))).not.toContain("sk-NESTED-SECRET");
  });

  it("models 是非秘密,脱敏后必须完整保留 —— 否则设置页列表会空", () => {
    const parsed = spec.parse(
      JSON.stringify({
        defaultModelId: "ds",
        keys: { deepseek: "sk-x" },
        models: [
          {
            id: "ds",
            label: "DeepSeek",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            baseURL: "https://api.deepseek.com",
            keyRef: "deepseek",
          },
        ],
      })
    );
    const redacted = spec.redact(parsed) as {
      providers: Record<string, { models: unknown[]; label: string; baseURL: string }>;
      defaultModel: { providerId: string; model: string };
    };
    expect(redacted.providers.deepseek.models).toEqual([
      { model: "deepseek-v4-flash", label: "DeepSeek" },
    ]);
    expect(redacted.defaultModel).toEqual({ providerId: "deepseek", model: "deepseek-v4-flash" });
    expect(redacted.providers.deepseek.baseURL).toBe("https://api.deepseek.com");
  });

  it("hasSecret:任意一个实例有非空 key 即为已配置", () => {
    const withKey = spec.parse(
      JSON.stringify({ defaultModelId: null, keys: { deepseek: "sk-x" }, models: [] })
    );
    const withoutKey = spec.parse(
      JSON.stringify({ defaultModelId: null, keys: { deepseek: "" }, models: [] })
    );
    expect(spec.hasSecret(withKey)).toBe(true);
    expect(spec.hasSecret(withoutKey)).toBe(false);
  });

  it("hasSecret:旧形状的顶层 apiKey 仍然算已配置", () => {
    const legacy = spec.parse(
      JSON.stringify({ provider: "deepseek", model: "m", apiKey: "sk-x" })
    );
    expect(spec.hasSecret(legacy)).toBe(true);
  });

  it("从旧格式搬运过来的那把 key 同样不外泄 —— 升级路径不能开天窗", () => {
    // parseLlmChatDocument 会把 mergePatch 带进来的顶层 apiKey 搬进某个实例
    // (否则用户升级时会丢 key)。搬完之后它仍然是秘密,必须照样被脱敏挡住。
    const parsed = spec.parse(
      JSON.stringify({ apiKey: "sk-MIGRATED-SECRET", defaultModelId: null, keys: {}, models: [] })
    );
    const serialized = JSON.stringify(spec.redact(parsed));
    expect(serialized).not.toContain("sk-MIGRATED-SECRET");
    // 而且 UI 要看得出这个槽位已经有 key 了。
    const redacted = spec.redact(parsed) as { providers: Record<string, { hasKey: boolean }> };
    expect(Object.values(redacted.providers).some((p) => p.hasKey)).toBe(true);
  });

  it("secretFields 同时覆盖两种形状的秘密位置", () => {
    expect([...spec.secretFields].sort()).toEqual(["apiKey", "keys"]);
  });

  it("★ SC7 hasSecret:只在 providers.*.apiKey 里配 key 也算已配置", () => {
    // 新形状下密钥不在顶层。谓词跟着形状走,否则设置页把「配好了」显示成「没配」。
    const parsed = spec.parse(
      JSON.stringify({
        providers: {
          x: { provider: "deepseek", baseURL: "https://api.deepseek.com", apiKey: "sk-x", models: [] },
        },
      })
    );
    expect(spec.hasSecret(parsed)).toBe(true);
    const noKey = spec.parse(
      JSON.stringify({
        providers: { x: { provider: "deepseek", baseURL: "https://api.deepseek.com", models: [] } },
      })
    );
    expect(spec.hasSecret(noKey)).toBe(false);
  });
});

describe("★ SC8 脱敏值被回写时不能吃掉真密钥", () => {
  /**
   * 脱敏 DTO 里 apiKey 被换成了 `hasKey: true`。前端只要把它原样回写
   * (或写成 apiKey:true),mergePatch 就会把 apiKey 设成 true,
   * 然后 parse 的 optionalTrimmedString(true) 返回 undefined —— **密钥静默消失**,
   * 不报错、200 OK。这与 isMaskPlaceholder 挡「********」是同一类事故,
   * 只是类型混淆这条原先没人挡。
   */
  it("apiKey 不是字符串也不是 null → 拒绝,不是照单全收", () => {
    for (const bad of [true, 1, {}, []]) {
      expect(() =>
        mergePatch(
          { providers: { x: { apiKey: "sk-真的" } } },
          { providers: { x: { apiKey: bad } } } as Record<string, unknown>
        )
      ).toThrow(/apiKey/);
    }
  });

  it("null 仍然是合法的「清掉这个字段」,不能被误伤", () => {
    const out = mergePatch({ providers: { x: { apiKey: "sk-真的", label: "L" } } }, {
      providers: { x: { apiKey: null } },
    });
    expect((out.providers as Record<string, Record<string, unknown>>).x.apiKey).toBeUndefined();
    expect((out.providers as Record<string, Record<string, unknown>>).x.label).toBe("L");
  });

  it("字符串照常通过", () => {
    const out = mergePatch({}, { providers: { x: { apiKey: "sk-新的" } } });
    expect((out.providers as Record<string, Record<string, unknown>>).x.apiKey).toBe("sk-新的");
  });

  it("★ 每个 spec 的 secretFields 都必须被分类 —— 新加一个密钥字段要被迫做决定", () => {
    // 这是 spec.secretFields 唯一的读者(生产代码仍然不读它)。作用是:
    // 有人加了新密钥字段却忘了归类时,这条会红,而不是悄悄绕过类型闸。
    const classified = new Set<string>([...STRING_SECRET_FIELDS, ...OBJECT_SECRET_FIELDS]);
    for (const [name, s] of Object.entries(CREDENTIAL_SPECS)) {
      for (const f of s.secretFields) {
        expect(classified.has(f), `${name}.secretFields 里的 "${f}" 还没分类`).toBe(true);
      }
    }
  });
});
