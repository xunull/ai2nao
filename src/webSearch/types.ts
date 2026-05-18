export type WebSearchProviderName = "brave";

export type WebSearchProviderCapabilities = {
  freshness: boolean;
  safeSearch: boolean;
  resultLanguage: boolean;
  pageFetch: boolean;
};

export type WebSearchConfig = {
  provider: WebSearchProviderName;
  apiKey: string | null;
  configured: boolean;
  configPath: string;
  timeoutMs: number;
  defaultResults: number;
  maxResults: number;
  snippetMaxChars: number;
  cacheTtlMs: number;
  toolResultMaxChars: number;
};

export type WebSearchStatus = {
  provider: WebSearchProviderName;
  configured: boolean;
  ok: boolean;
  configPath: string;
  capabilities: WebSearchProviderCapabilities;
  cacheTtlMs: number;
  error: string | null;
};

export type WebSearchRequest = {
  query: string;
  count?: number;
  reason?: string;
};

export type WebSearchProviderResult = {
  title: string;
  url: string;
  snippet: string;
};

export type WebSearchProviderResponse = {
  provider: WebSearchProviderName;
  results: WebSearchProviderResult[];
};

export type WebSearchDiagnosticEvent = {
  id: string;
  ts: string;
  provider: WebSearchProviderName;
  status:
    | "success"
    | "cache_hit"
    | "config_missing"
    | "sensitive_blocked"
    | "auth_error"
    | "rate_limited"
    | "timeout"
    | "parse_error"
    | "provider_error"
    | "invalid_input"
    | "disabled";
  queryHash?: string;
  durationMs?: number;
  resultCount?: number;
  error?: string;
};
