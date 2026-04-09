import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defaultLlmChatConfigPath } from "../config.js";
import { llmChatLog } from "./log.js";

export type LlmChatProvider = "openai-compatible";

export type LlmChatConfig = {
  provider: LlmChatProvider;
  /** Base URL including `/v1` when the server expects it (OpenAI, LM Studio, Ollama compat). */
  baseURL: string;
  model: string;
  /** Optional; falls back to `AI2NAO_LLM_API_KEY` or `OPENAI_API_KEY`. */
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

export function parseLlmChatConfigJson(raw: string): LlmChatConfig | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const provider = data.provider;
  const baseURL = data.baseURL;
  const model = data.model;
  if (provider !== "openai-compatible") return null;
  if (typeof baseURL !== "string" || !baseURL.trim()) return null;
  if (typeof model !== "string" || !model.trim()) return null;
  const apiKey =
    typeof data.apiKey === "string" && data.apiKey.trim() ? data.apiKey.trim() : undefined;
  return {
    provider: "openai-compatible",
    baseURL: baseURL.trim(),
    model: model.trim(),
    apiKey,
  };
}

export function readLlmChatConfig(): LlmChatConfig | null {
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
