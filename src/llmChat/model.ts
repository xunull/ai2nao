import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { LlmChatConfig } from "./config.js";
import { llmChatLog } from "./log.js";

function apiKeySource(cfg: LlmChatConfig): "config" | "AI2NAO_LLM_API_KEY" | "OPENAI_API_KEY" | "placeholder" {
  if (cfg.apiKey?.trim()) return "config";
  if (process.env.AI2NAO_LLM_API_KEY?.trim()) return "AI2NAO_LLM_API_KEY";
  if (process.env.OPENAI_API_KEY?.trim()) return "OPENAI_API_KEY";
  return "placeholder";
}

export function createChatLanguageModel(cfg: LlmChatConfig): LanguageModel {
  if (cfg.provider !== "openai-compatible") {
    throw new Error(`Unsupported LLM provider: ${cfg.provider}`);
  }
  const baseURL = cfg.baseURL.replace(/\/$/, "");
  const apiKey =
    cfg.apiKey?.trim() ||
    process.env.AI2NAO_LLM_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "local-no-key";
  llmChatLog.debug("create model", {
    baseURL,
    model: cfg.model,
    apiKeyFrom: apiKeySource(cfg),
  });
  const openai = createOpenAI({ baseURL, apiKey });
  return openai.chat(cfg.model);
}
