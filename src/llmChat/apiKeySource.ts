/**
 * API key 的来源判定。**只此一份。**
 *
 * 抽出来的理由:`model.ts` 要用它决定真正发出去的 key,`config.ts` 要用它决定
 * picker 里某个模型能不能选。两处若各写一套,就会出现「界面说能用、发出去 401」
 * 或反过来「界面置灰、其实靠环境变量能跑」的分歧 —— 后者正是 `keySet` 谓词的死因。
 *
 * 本文件对 `config.ts` 只做 type-only import,运行期无依赖,不成环。
 */
import type { LlmChatProvider } from "./config.js";

export type ProviderApiKeyEnv =
  | "ALIBABA_API_KEY"
  | "DEEPSEEK_API_KEY"
  | "MOONSHOT_API_KEY"
  | "OPENAI_API_KEY"
  | "ARK_API_KEY"
  | "MINIMAX_API_KEY";

export type ApiKeySource =
  | "config"
  | ProviderApiKeyEnv
  | "AI2NAO_LLM_API_KEY"
  | "placeholder"
  | "missing";

/**
 * 每家的约定环境变量。返回 null 表示「这家没有约定的环境变量」——
 * 只有 `openai-compatible` 属于此类,它会一路落到本地占位符,
 * 因为 LM Studio / Ollama 这类本地端点本来就不需要 key。
 */
export function providerApiKeyEnv(provider: LlmChatProvider): ProviderApiKeyEnv | null {
  if (provider === "alibaba") return "ALIBABA_API_KEY";
  if (provider === "deepseek") return "DEEPSEEK_API_KEY";
  if (provider === "moonshotai") return "MOONSHOT_API_KEY";
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "volcengine") return "ARK_API_KEY";
  if (provider === "minimax") return "MINIMAX_API_KEY";
  return null;
}

/**
 * 解析顺序,与本函数抽出前 `model.ts` 里的实现逐行一致(不是重写,是搬家):
 * 显式 key → 该厂商的环境变量 → 共享的 AI2NAO_LLM_API_KEY → (仅无约定环境变量的)
 * OPENAI_API_KEY → 本地占位符。
 *
 * `env` 参数化只为可测,生产调用点一律省略走 `process.env`。
 */
export function resolveApiKeySource(
  input: { provider: LlmChatProvider; apiKey?: string },
  env: NodeJS.ProcessEnv = process.env
): { apiKey?: string; source: ApiKeySource } {
  if (input.apiKey?.trim()) return { apiKey: input.apiKey.trim(), source: "config" };
  const providerEnv = providerApiKeyEnv(input.provider);
  if (providerEnv) {
    const providerKey = env[providerEnv]?.trim();
    if (providerKey) return { apiKey: providerKey, source: providerEnv };
    const sharedKey = env.AI2NAO_LLM_API_KEY?.trim();
    if (sharedKey) return { apiKey: sharedKey, source: "AI2NAO_LLM_API_KEY" };
    return { source: "missing" };
  }
  const sharedKey = env.AI2NAO_LLM_API_KEY?.trim();
  if (sharedKey) return { apiKey: sharedKey, source: "AI2NAO_LLM_API_KEY" };
  const openaiKey = env.OPENAI_API_KEY?.trim();
  if (openaiKey) return { apiKey: openaiKey, source: "OPENAI_API_KEY" };
  return { apiKey: "local-no-key", source: "placeholder" };
}

/** 给 UI 用的粗粒度分类。`none` 是唯一表示「选不了」的值。 */
export type CredentialSource = "config" | "env" | "none-needed" | "none";

export function credentialSourceOf(source: ApiKeySource): CredentialSource {
  if (source === "config") return "config";
  if (source === "missing") return "none";
  if (source === "placeholder") return "none-needed";
  return "env";
}
