import type { AiEvidenceItem, AiEvidenceToolResult } from "../llmTools/evidence.js";
import { readWebSearchConfig } from "./config.js";
import { WebSearchMemoryCache } from "./cache.js";
import { createWebSearchDiagnostics, statusFromErrorCode, type WebSearchDiagnostics } from "./diagnostics.js";
import { isWebSearchError, ToolUnavailableError, WebSearchError } from "./errors.js";
import type { WebSearchProvider } from "./provider.js";
import { BraveSearchProvider } from "./brave.js";
import { clampResultCount, normalizeCacheQuery, sanitizeWebSearchQuery } from "./sanitize.js";
import type { WebSearchConfig, WebSearchProviderResponse, WebSearchRequest, WebSearchStatus } from "./types.js";
import { webSearchStatusFromConfig } from "./config.js";

export type WebSearchService = {
  status(): WebSearchStatus & { diagnostics: ReturnType<WebSearchDiagnostics["recent"]> };
  search(input: WebSearchRequest, opts?: { enabled?: boolean; signal?: AbortSignal }): Promise<AiEvidenceToolResult>;
};

export type WebSearchServiceDeps = {
  config?: WebSearchConfig;
  provider?: WebSearchProvider;
  cache?: WebSearchMemoryCache<WebSearchProviderResponse>;
  diagnostics?: WebSearchDiagnostics;
  now?: () => Date;
};

const DEFAULT_DIAGNOSTICS = createWebSearchDiagnostics();
let DEFAULT_SERVICE: WebSearchService | null = null;

export function getDefaultWebSearchService(): WebSearchService {
  if (!DEFAULT_SERVICE) DEFAULT_SERVICE = createWebSearchService();
  return DEFAULT_SERVICE;
}

export function createWebSearchService(deps: WebSearchServiceDeps = {}): WebSearchService {
  const config = deps.config ?? readWebSearchConfig();
  const diagnostics = deps.diagnostics ?? DEFAULT_DIAGNOSTICS;
  const cache = deps.cache ?? new WebSearchMemoryCache<WebSearchProviderResponse>();
  const now = deps.now ?? (() => new Date());
  const provider =
    deps.provider ??
    (config.apiKey
      ? new BraveSearchProvider({ apiKey: config.apiKey, timeoutMs: config.timeoutMs })
      : null);

  return {
    status() {
      return {
        ...webSearchStatusFromConfig(config),
        diagnostics: diagnostics.recent(10),
      };
    },

    async search(input, opts = {}) {
      const started = Date.now();
      let query = "";
      let queryHash: string | undefined;
      try {
        if (opts.enabled === false) throw new ToolUnavailableError("Web Search is turned off");
        if (!config.configured || !provider) throw new ToolUnavailableError("BRAVE_SEARCH_API_KEY is not configured");
        query = sanitizeWebSearchQuery(input.query);
        queryHash = diagnostics.hashQuery(query);
        const count = clampResultCount(input.count, config.defaultResults, config.maxResults);
        const cacheKey = `${config.provider}:${normalizeCacheQuery(query)}:${count}`;
        const cached = cache.get(cacheKey);
        if (cached) {
          const event = diagnostics.record({
            provider: config.provider,
            status: "cache_hit",
            queryHash,
            durationMs: Date.now() - started,
            resultCount: cached.results.length,
          });
          return toEvidenceResult(cached, query, input.reason, now(), config, true, event.id);
        }

        const providerResult = await provider.search({ query, count, signal: opts.signal });
        cache.set(cacheKey, providerResult, config.cacheTtlMs);
        const event = diagnostics.record({
          provider: config.provider,
          status: "success",
          queryHash,
          durationMs: Date.now() - started,
          resultCount: providerResult.results.length,
        });
        return toEvidenceResult(providerResult, query, input.reason, now(), config, false, event.id);
      } catch (error) {
        const webError = isWebSearchError(error)
          ? error
          : new WebSearchError("provider_error", error instanceof Error ? error.message : String(error), true);
        const event = diagnostics.record({
          provider: config.provider,
          status: statusFromErrorCode(webError.code),
          queryHash: queryHash ?? (query ? diagnostics.hashQuery(query) : undefined),
          durationMs: Date.now() - started,
          resultCount: 0,
          error: webError.code,
        });
        return {
          ok: false,
          kind: "evidence_error",
          source: "web",
          queryHash: event.queryHash,
          code: webError.code,
          message: webError.message,
          recoverable: webError.recoverable,
        };
      }
    },
  };
}

function toEvidenceResult(
  response: WebSearchProviderResponse,
  query: string,
  reason: string | undefined,
  generatedAt: Date,
  config: WebSearchConfig,
  cached: boolean,
  diagnosticsId: string
): AiEvidenceToolResult {
  const evidence = response.results.slice(0, config.maxResults).map<AiEvidenceItem>((item, index) => ({
    id: `web-${index + 1}`,
    source: "web",
    title: truncateField(item.title, 160),
    url: truncateField(item.url, 2048),
    snippet: truncateField(item.snippet, config.snippetMaxChars),
    rank: index + 1,
    provider: response.provider,
    fetchedAt: generatedAt.toISOString(),
  }));
  return {
    ok: true,
    kind: "evidence",
    source: "web",
    query,
    reason,
    generatedAt: generatedAt.toISOString(),
    evidence,
    meta: {
      provider: response.provider,
      cached,
      diagnosticsId,
    },
  };
}

function truncateField(value: string, maxChars: number): string {
  const clean = value.trim().replace(/\s+/g, " ");
  return clean.length > maxChars ? `${clean.slice(0, Math.max(0, maxChars - 3))}...` : clean;
}
