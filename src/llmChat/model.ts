import { createAlibaba } from "@ai-sdk/alibaba";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { resolveApiKeySource } from "./apiKeySource.js";
import type { LlmChatConfig } from "./config.js";
import { llmChatLog } from "./log.js";

// key 解析已搬到 apiKeySource.ts —— picker 的可用性判定要用同一份逻辑,
// 两处各写一套就会出现「界面说能用、发出去 401」的分歧。这里只是转调,不是重写。
function resolveApiKey(cfg: LlmChatConfig) {
  return resolveApiKeySource({ provider: cfg.provider, apiKey: cfg.apiKey });
}

export function createChatLanguageModel(cfg: LlmChatConfig): LanguageModel {
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
    });
    return provider.chatModel(cfg.model);
  }
  const _exhaustive: never = cfg;
  throw new Error(`Unsupported LLM provider: ${_exhaustive}`);
}
