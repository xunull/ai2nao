import { createAlibaba } from "@ai-sdk/alibaba";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { LlmChatConfig, LlmChatProvider } from "./config.js";
import { llmChatLog } from "./log.js";

type ProviderApiKeyEnv =
  | "ALIBABA_API_KEY"
  | "DEEPSEEK_API_KEY"
  | "MOONSHOT_API_KEY"
  | "OPENAI_API_KEY";

type ApiKeySource =
  | "config"
  | ProviderApiKeyEnv
  | "AI2NAO_LLM_API_KEY"
  | "placeholder"
  | "missing";

function providerApiKeyEnv(provider: LlmChatProvider): ProviderApiKeyEnv | null {
  if (provider === "alibaba") return "ALIBABA_API_KEY";
  if (provider === "deepseek") return "DEEPSEEK_API_KEY";
  if (provider === "moonshotai") return "MOONSHOT_API_KEY";
  if (provider === "openai") return "OPENAI_API_KEY";
  return null;
}

function resolveApiKey(cfg: LlmChatConfig): { apiKey?: string; source: ApiKeySource } {
  if (cfg.apiKey?.trim()) return { apiKey: cfg.apiKey.trim(), source: "config" };
  const providerEnv = providerApiKeyEnv(cfg.provider);
  if (providerEnv) {
    const providerKey = process.env[providerEnv]?.trim();
    if (providerKey) return { apiKey: providerKey, source: providerEnv };
    const sharedKey = process.env.AI2NAO_LLM_API_KEY?.trim();
    if (sharedKey) return { apiKey: sharedKey, source: "AI2NAO_LLM_API_KEY" };
    return { source: "missing" };
  }
  const sharedKey = process.env.AI2NAO_LLM_API_KEY?.trim();
  if (sharedKey) return { apiKey: sharedKey, source: "AI2NAO_LLM_API_KEY" };
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  if (openaiKey) return { apiKey: openaiKey, source: "OPENAI_API_KEY" };
  return { apiKey: "local-no-key", source: "placeholder" };
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
  if (cfg.provider === "openai-compatible") {
    const provider = createOpenAICompatible<string, string, string, string>({
      name: "openai-compatible",
      baseURL,
      apiKey,
    });
    return provider.chatModel(cfg.model);
  }
  const _exhaustive: never = cfg;
  throw new Error(`Unsupported LLM provider: ${_exhaustive}`);
}
