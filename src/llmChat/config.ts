import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defaultLlmChatConfigPath } from "../config.js";
import { getCredentialRaw } from "../settings/store.js";
import { llmChatLog } from "./log.js";

export type LlmChatProvider =
  | "alibaba"
  | "deepseek"
  | "moonshotai"
  | "openai"
  | "openai-compatible";

export type LlmChatConfig =
  | {
      provider: "deepseek";
      /** DeepSeek API base URL. Do not append `/v1` for the official API. */
      baseURL: string;
      model: string;
      /** Optional; falls back to `DEEPSEEK_API_KEY` or `AI2NAO_LLM_API_KEY`. */
      apiKey?: string;
    }
  | {
      provider: "moonshotai";
      /** Moonshot API base URL, defaulting to `https://api.moonshot.ai/v1`. */
      baseURL: string;
      model: string;
      /** Optional; falls back to `MOONSHOT_API_KEY` or `AI2NAO_LLM_API_KEY`. */
      apiKey?: string;
    }
  | {
      provider: "alibaba";
      /** DashScope OpenAI-compatible base URL. */
      baseURL: string;
      model: string;
      /** Optional; falls back to `ALIBABA_API_KEY` or `AI2NAO_LLM_API_KEY`. */
      apiKey?: string;
    }
  | {
      provider: "openai";
      /** OpenAI API base URL, defaulting to `https://api.openai.com/v1`. */
      baseURL: string;
      model: string;
      /** Optional; falls back to `OPENAI_API_KEY` or `AI2NAO_LLM_API_KEY`. */
      apiKey?: string;
    }
  | {
      provider: "openai-compatible";
      /** Base URL including `/v1` when the server expects it (LM Studio, Ollama compat). */
      baseURL: string;
      model: string;
      /** Optional; falls back to `AI2NAO_LLM_API_KEY`, `OPENAI_API_KEY`, or a local placeholder. */
      apiKey?: string;
    };

export type LlmChatStatus = {
  configured: boolean;
  provider: LlmChatProvider | null;
  model: string | null;
  /** Host only, for debugging (no path, no key). */
  baseHost: string | null;
  configPath: string;
};

function configPathFromEnv(): string {
  const raw = (process.env.AI2NAO_LLM_CHAT_CONFIG ?? "").trim();
  return raw.length > 0 ? resolve(raw) : defaultLlmChatConfigPath();
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function optionalTrimmedString(x: unknown): string | undefined {
  return typeof x === "string" && x.trim() ? x.trim() : undefined;
}

export function parseLlmChatConfigJson(raw: string): LlmChatConfig | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const provider = data.provider;
  const baseURL = optionalTrimmedString(data.baseURL);
  const model = optionalTrimmedString(data.model);
  if (!model) return null;
  const apiKey = optionalTrimmedString(data.apiKey);
  if (provider === "deepseek") {
    return {
      provider: "deepseek",
      baseURL: baseURL ?? "https://api.deepseek.com",
      model,
      apiKey,
    };
  }
  if (provider === "moonshotai") {
    return {
      provider: "moonshotai",
      baseURL: baseURL ?? "https://api.moonshot.ai/v1",
      model,
      apiKey,
    };
  }
  if (provider === "alibaba") {
    return {
      provider: "alibaba",
      baseURL: baseURL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      model,
      apiKey,
    };
  }
  if (provider === "openai") {
    return {
      provider: "openai",
      baseURL: baseURL ?? "https://api.openai.com/v1",
      model,
      apiKey,
    };
  }
  if (provider === "openai-compatible") {
    if (!baseURL) return null;
    return {
      provider: "openai-compatible",
      baseURL,
      model,
      apiKey,
    };
  }
  return null;
}

/**
 * Config source, in order: config.db → JSON file. (The API-key ENV fallback
 * lives downstream in model.ts as `cfg.apiKey || env`, so it is deliberately
 * NOT consulted here — moving it would silently change precedence.)
 */
export function readLlmChatConfig(): LlmChatConfig | null {
  const stored = getCredentialRaw("llm-chat");
  if (stored) {
    const cfg = parseLlmChatConfigJson(stored);
    if (cfg) {
      llmChatLog.debug("config loaded from config.db", {
        provider: cfg.provider,
        model: cfg.model,
      });
      return cfg;
    }
    llmChatLog.warn("config.db holds an invalid llm-chat value; falling back to file");
  }
  const path = configPathFromEnv();
  if (!existsSync(path)) {
    llmChatLog.debug("config file missing", path);
    return null;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const cfg = parseLlmChatConfigJson(raw);
    if (!cfg) {
      llmChatLog.warn("config file present but invalid JSON shape", path);
      return null;
    }
    llmChatLog.debug("config loaded", {
      path,
      provider: cfg.provider,
      model: cfg.model,
      baseHost: baseHostFromUrl(cfg.baseURL),
    });
    return cfg;
  } catch (e) {
    llmChatLog.warn("config read failed", path, e instanceof Error ? e.message : String(e));
    return null;
  }
}

function baseHostFromUrl(baseURL: string): string | null {
  try {
    const u = new URL(baseURL);
    return u.host || null;
  } catch {
    return null;
  }
}

export function llmChatStatus(): LlmChatStatus {
  const configPath = configPathFromEnv();
  const cfg = readLlmChatConfig();
  if (!cfg) {
    return {
      configured: false,
      provider: null,
      model: null,
      baseHost: null,
      configPath,
    };
  }
  return {
    configured: true,
    provider: cfg.provider,
    model: cfg.model,
    baseHost: baseHostFromUrl(cfg.baseURL),
    configPath,
  };
}
