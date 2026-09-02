import { describe, expect, it } from "vitest";
import { CREDENTIAL_SPECS } from "../src/settings/schema.js";

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

  it("脱敏后 UI 仍能看出哪家配了 key(presence map,不是整块抹掉)", () => {
    const parsed = spec.parse(
      JSON.stringify({
        defaultModelId: null,
        keys: { deepseek: "sk-x", moonshotai: "" },
        models: [],
      })
    );
    const redacted = spec.redact(parsed) as { keys?: Record<string, boolean> };
    expect(redacted.keys).toEqual({ deepseek: true, moonshotai: false });
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
    const redacted = spec.redact(parsed) as { models?: unknown[]; defaultModelId?: string };
    expect(redacted.models).toHaveLength(1);
    expect(redacted.defaultModelId).toBe("ds");
  });

  it("hasSecret:keys 里有任意一把非空即为已配置", () => {
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

  it("secretFields 同时覆盖两种形状的秘密位置", () => {
    expect([...spec.secretFields].sort()).toEqual(["apiKey", "keys"]);
  });
});
