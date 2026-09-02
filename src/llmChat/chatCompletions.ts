/**
 * 共享的「llm-chat 配置 → OpenAI 兼容 chat 调用」原语。
 *
 * 工作复盘(workRecap)与每日摘要(dailySummary)都从同一份 llm-chat 配置
 * (设置 → AI 与模型)里解析 bearer key 和 /chat/completions 端点,规则完全一致,
 * 所以放这里一处维护,避免各写一份。
 */
import type { LlmChatConfig } from "./config.js";

/**
 * **与 `apiKeySource.ts` 的同名函数是有意重复的,不要合并。**
 *
 * 两者兜底顺序不同:本文件对 `openai-compatible` 不查 `OPENAI_API_KEY`,
 * 直接回落 `"local-no-key"`;`apiKeySource` 多一步。本文件服务 dailySummary 与
 * workRecap,它们属于「多模型改造中行为必须一字不变」的消费者,所以宁可留重复。
 * 合并前要先证明这一步差异对这两个消费者无影响,并补上专盯它的断言。
 *
 * 这个 switch 没有 default —— 返回类型不含 undefined,加 provider 时 tsc 会报
 * 「lacks ending return statement」,这正是它被发现的方式。
 */
function providerApiKeyEnv(provider: LlmChatConfig["provider"]): string | null {
  switch (provider) {
    case "deepseek":
      return "DEEPSEEK_API_KEY";
    case "moonshotai":
      return "MOONSHOT_API_KEY";
    case "alibaba":
      return "ALIBABA_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "volcengine":
      return "ARK_API_KEY";
    case "minimax":
      return "MINIMAX_API_KEY";
    case "openai-compatible":
      return null;
  }
}

/**
 * 解析 bearer key:显式 key → provider 专属 env → 共享 AI2NAO_LLM_API_KEY →
 * openai-compatible 回落 "local-no-key"(本地 runtime 本就无需 key)→ null。
 */
export function resolveLlmChatApiKey(cfg: LlmChatConfig): string | null {
  if (cfg.apiKey?.trim()) return cfg.apiKey.trim();
  const envKey = providerApiKeyEnv(cfg.provider);
  if (envKey) {
    const fromEnv = process.env[envKey]?.trim();
    if (fromEnv) return fromEnv;
  }
  const shared = process.env.AI2NAO_LLM_API_KEY?.trim();
  if (shared) return shared;
  if (cfg.provider === "openai-compatible") return "local-no-key";
  return null;
}

function isOpenAiCompatBase(url: string): boolean {
  return /\/v\d+\/?$/.test(url) || url.endsWith("/openai/v1");
}

/** 构造 chat-completions 端点;对不带 `/v1` 的 base(如 DeepSeek)补上 `/v1`。 */
export function chatCompletionsUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/$/, "");
  if (isOpenAiCompatBase(trimmed)) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}
