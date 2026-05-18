import {
  SearchProviderAuthError,
  SearchProviderParseError,
  SearchProviderRateLimitError,
  SearchProviderTimeoutError,
  WebSearchError,
} from "./errors.js";
import type { WebSearchProvider } from "./provider.js";
import type { WebSearchProviderResponse, WebSearchProviderResult } from "./types.js";

export type BraveSearchProviderOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
};

type BraveSearchResponse = {
  web?: {
    results?: Array<{
      title?: unknown;
      url?: unknown;
      description?: unknown;
    }>;
  };
};

export class BraveSearchProvider implements WebSearchProvider {
  readonly provider = "brave" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: BraveSearchProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? "https://api.search.brave.com/res/v1/web/search";
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  async search(args: {
    query: string;
    count: number;
    signal?: AbortSignal;
  }): Promise<WebSearchProviderResponse> {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), this.timeoutMs);
    const signal = args.signal ? AbortSignal.any([args.signal, ac.signal]) : ac.signal;
    try {
      const url = new URL(this.endpoint);
      url.searchParams.set("q", args.query);
      url.searchParams.set("count", String(args.count));
      const res = await this.fetchImpl(url, {
        signal,
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": this.options.apiKey,
        },
      });
      if (res.status === 401 || res.status === 403) {
        throw new SearchProviderAuthError();
      }
      if (res.status === 429) {
        throw new SearchProviderRateLimitError();
      }
      if (!res.ok) {
        throw new WebSearchError("provider_error", `Search provider returned HTTP ${res.status}`, true);
      }
      let body: BraveSearchResponse;
      try {
        body = (await res.json()) as BraveSearchResponse;
      } catch {
        throw new SearchProviderParseError();
      }
      return { provider: this.provider, results: normalizeBraveResults(body) };
    } catch (error) {
      if (error instanceof WebSearchError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new SearchProviderTimeoutError();
      }
      throw new WebSearchError("provider_error", error instanceof Error ? error.message : String(error), true);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeBraveResults(body: BraveSearchResponse): WebSearchProviderResult[] {
  if (!body || typeof body !== "object") {
    throw new SearchProviderParseError();
  }
  const rows = Array.isArray(body.web?.results) ? body.web.results : [];
  return rows
    .map((row) => {
      const title = typeof row.title === "string" ? row.title.trim() : "";
      const url = typeof row.url === "string" ? row.url.trim() : "";
      const snippet = typeof row.description === "string" ? row.description.trim() : "";
      if (!title || !url) return null;
      return { title, url, snippet };
    })
    .filter((row): row is WebSearchProviderResult => row !== null);
}
