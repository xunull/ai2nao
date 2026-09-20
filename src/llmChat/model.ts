import { createAlibaba } from "@ai-sdk/alibaba";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
/**
 * 返回类型要窄到 `LanguageModelV3`,不能用 `ai` 的 `LanguageModel` ——
 * 后者是 `GlobalProviderModelId | LanguageModelV3 | LanguageModelV2`,**含字符串形态**,
 * 而 `wrapLanguageModel`(记账中间件要用)只收 `LanguageModelV3` 对象,类型对不上。
 *
 * 不直接 import `LanguageModelV3`:它是 `ai` 从 `@ai-sdk/provider` 引进来自用的,
 * 既不在 `ai` 的导出清单里,`@ai-sdk/provider` 也没有扁平安装到 node_modules 顶层。
 * 为一个类型标注新增一条直接依赖不划算,所以从已有的 provider 工厂反推 ——
 * 五家工厂(`chat` / `chatModel`)的返回类型都是 `LanguageModelV3`,取哪个都等价。
 */
export type ChatLanguageModel = ReturnType<ReturnType<typeof createDeepSeek>["chat"]>;
import { resolveApiKeySource } from "./apiKeySource.js";
import type { LlmChatConfig } from "./config.js";
import { llmChatLog } from "./log.js";

// key 解析已搬到 apiKeySource.ts —— picker 的可用性判定要用同一份逻辑,
// 两处各写一套就会出现「界面说能用、发出去 401」的分歧。这里只是转调,不是重写。
function resolveApiKey(cfg: LlmChatConfig) {
  return resolveApiKeySource({ provider: cfg.provider, apiKey: cfg.apiKey });
}

export function createChatLanguageModel(cfg: LlmChatConfig): ChatLanguageModel {
  const baseURL = cfg.baseURL.replace(/\/$/, "");
  const { apiKey, source } = resolveApiKey(cfg);
  llmChatLog.debug("create model", {
    provider: cfg.provider,
    baseURL,
    model: cfg.model,
    apiKeyFrom: source,
  });
  if (cfg.provider === "deepseek") {
    const deepseek = createDeepSeek({ baseURL, ...(apiKey ? { apiKey } : {}) });
    return deepseek.chat(cfg.model);
  }
  if (cfg.provider === "moonshotai") {
    const moonshotai = createMoonshotAI({ baseURL, ...(apiKey ? { apiKey } : {}) });
    return moonshotai.chatModel(cfg.model);
  }
  if (cfg.provider === "alibaba") {
    const alibaba = createAlibaba({ baseURL, ...(apiKey ? { apiKey } : {}) });
    return alibaba.chatModel(cfg.model);
  }
  if (cfg.provider === "openai") {
    const openai = createOpenAI({ baseURL, ...(apiKey ? { apiKey } : {}) });
    return openai.chat(cfg.model);
  }
  // 下面三家共用 openai-compatible 适配器,但各有独立的 provider id ——
  // 为的是设置页能预填 base URL(火山那串 ark 路径没人记得住),
  // 以及 apiKeySource 能给它们各自的约定环境变量。
  if (
    cfg.provider === "openai-compatible" ||
    cfg.provider === "volcengine" ||
    cfg.provider === "minimax"
  ) {
    const provider = createOpenAICompatible<string, string, string, string>({
      name: cfg.provider,
      baseURL,
      apiKey,
      // **流式请求必须要用量。** 这个适配器默认不发 `stream_options.include_usage`,
      // 厂商于是每个分片都回 `usage: null` —— 这三家的每一笔账都只能记成「未知」,
      // 花了多少钱永远不知道(2026-09-19 真实 MiniMax-M3 实测照出;DeepSeek /
      // OpenAI 的适配器默认就带)。
      includeUsage: true,
    });
    return provider.chatModel(cfg.model);
  }
  // LlmChatConfig 不再是可辨识联合(provider 与 baseURL/model 已解耦),所以穷尽性
  // 检查改成盯 provider 字段本身。这条 never 是「加一家厂商必须补一条适配分支」的
  // 唯一强制点 —— 删掉它,新厂商会一路走到运行期才抛。
  const _exhaustive: never = cfg.provider;
  throw new Error(`Unsupported LLM provider: ${String(_exhaustive)}`);
}
