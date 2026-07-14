import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultWebSearchConfigPath } from "../config.js";
import { getCredentialRaw } from "../settings/store.js";
import type { WebSearchConfig, WebSearchProviderCapabilities, WebSearchStatus } from "./types.js";

export const WEB_SEARCH_CAPABILITIES: WebSearchProviderCapabilities = {
  freshness: false,
  safeSearch: false,
  resultLanguage: false,
  pageFetch: false,
};

const DEFAULT_WEB_SEARCH_CONFIG = {
  provider: "brave" as const,
  timeoutMs: 8_000,
  defaultResults: 5,
  maxResults: 8,
  snippetMaxChars: 500,
  cacheTtlMs: 300_000,
  toolResultMaxChars: 6_000,
};

type WebSearchConfigFile = {
  provider: "brave";
  apiKey?: string;
  timeoutMs?: number;
  defaultResults?: number;
  maxResults?: number;
  snippetMaxChars?: number;
  cacheTtlMs?: number;
  toolResultMaxChars?: number;
};

function configPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.AI2NAO_WEB_SEARCH_CONFIG ?? "").trim();
  return raw.length > 0 ? resolve(raw) : defaultWebSearchConfigPath();
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function optionalPositiveInt(value: unknown, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.trunc(value), max);
}

export function parseWebSearchConfigJson(raw: string): WebSearchConfigFile | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  if (data.provider !== undefined && data.provider !== "brave") return null;
  const apiKey = typeof data.apiKey === "string" && data.apiKey.trim()
    ? data.apiKey.trim()
    : undefined;
  return {
    provider: "brave",
    ...(apiKey ? { apiKey } : {}),
    ...(optionalPositiveInt(data.timeoutMs, 60_000) ? { timeoutMs: optionalPositiveInt(data.timeoutMs, 60_000) } : {}),
    ...(optionalPositiveInt(data.defaultResults, 20) ? { defaultResults: optionalPositiveInt(data.defaultResults, 20) } : {}),
    ...(optionalPositiveInt(data.maxResults, 20) ? { maxResults: optionalPositiveInt(data.maxResults, 20) } : {}),
    ...(optionalPositiveInt(data.snippetMaxChars, 4_000) ? { snippetMaxChars: optionalPositiveInt(data.snippetMaxChars, 4_000) } : {}),
    ...(optionalPositiveInt(data.cacheTtlMs, 3_600_000) ? { cacheTtlMs: optionalPositiveInt(data.cacheTtlMs, 3_600_000) } : {}),
    ...(optionalPositiveInt(data.toolResultMaxChars, 40_000) ? { toolResultMaxChars: optionalPositiveInt(data.toolResultMaxChars, 40_000) } : {}),
  };
}

export function readWebSearchConfigFile(path: string): WebSearchConfigFile | null {
  const p = resolve(path.trim());
  if (!existsSync(p)) return null;
  try {
    return parseWebSearchConfigJson(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Source order: BRAVE_SEARCH_API_KEY env → config.db → JSON file (env-first is
 * how this reader has always behaved; moving the db in front of it would change
 * precedence, so it goes second). */
export function readWebSearchConfig(env: NodeJS.ProcessEnv = process.env): WebSearchConfig {
  const configPath = configPathFromEnv(env);
  const stored = getCredentialRaw("web-search");
  const fileConfig =
    (stored ? parseWebSearchConfigJson(stored) : null) ?? readWebSearchConfigFile(configPath);
  const apiKey = env.BRAVE_SEARCH_API_KEY?.trim() || fileConfig?.apiKey || null;
  const maxResults = fileConfig?.maxResults ?? DEFAULT_WEB_SEARCH_CONFIG.maxResults;
  const defaultResults = Math.min(
    fileConfig?.defaultResults ?? DEFAULT_WEB_SEARCH_CONFIG.defaultResults,
    maxResults
  );
  return {
    provider: fileConfig?.provider ?? DEFAULT_WEB_SEARCH_CONFIG.provider,
    apiKey,
    configured: Boolean(apiKey),
    configPath,
    timeoutMs: fileConfig?.timeoutMs ?? DEFAULT_WEB_SEARCH_CONFIG.timeoutMs,
    defaultResults,
    maxResults,
    snippetMaxChars: fileConfig?.snippetMaxChars ?? DEFAULT_WEB_SEARCH_CONFIG.snippetMaxChars,
    cacheTtlMs: fileConfig?.cacheTtlMs ?? DEFAULT_WEB_SEARCH_CONFIG.cacheTtlMs,
    toolResultMaxChars: fileConfig?.toolResultMaxChars ?? DEFAULT_WEB_SEARCH_CONFIG.toolResultMaxChars,
  };
}

export function webSearchStatusFromConfig(config: WebSearchConfig): WebSearchStatus {
  return {
    provider: config.provider,
    configured: config.configured,
    ok: config.configured,
    configPath: config.configPath,
    capabilities: WEB_SEARCH_CAPABILITIES,
    cacheTtlMs: config.cacheTtlMs,
    error: config.configured
      ? null
      : `BRAVE_SEARCH_API_KEY is not configured and ${config.configPath} has no apiKey`,
  };
}
