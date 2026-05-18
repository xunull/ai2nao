import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { parseWebSearchConfigJson, readWebSearchConfig } from "../src/webSearch/config.js";
import { BraveSearchProvider } from "../src/webSearch/brave.js";
import { WebSearchMemoryCache } from "../src/webSearch/cache.js";
import { createWebSearchDiagnostics } from "../src/webSearch/diagnostics.js";
import {
  SearchProviderAuthError,
  SearchProviderParseError,
  SearchProviderRateLimitError,
} from "../src/webSearch/errors.js";
import { registerWebSearchRoutes } from "../src/webSearch/routes.js";
import { createWebSearchService } from "../src/webSearch/service.js";
import { normalizeCacheQuery, sanitizeWebSearchQuery } from "../src/webSearch/sanitize.js";
import type { WebSearchProvider } from "../src/webSearch/provider.js";
import type { WebSearchProviderResponse } from "../src/webSearch/types.js";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function configWithKey() {
  return readWebSearchConfig({ BRAVE_SEARCH_API_KEY: "test-key" });
}

describe("web search config and sanitization", () => {
  it("reports configured=false when BRAVE_SEARCH_API_KEY is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai2nao-web-search-missing-"));
    const cfg = readWebSearchConfig({ AI2NAO_WEB_SEARCH_CONFIG: join(dir, "missing.json") });
    expect(cfg.configured).toBe(false);
    expect(cfg.apiKey).toBeNull();
  });

  it("loads Brave API key from config file and lets env override it", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai2nao-web-search-"));
    const path = join(dir, "web-search.json");
    writeFileSync(
      path,
      JSON.stringify({
        provider: "brave",
        apiKey: "file-key",
        defaultResults: 7,
        maxResults: 9,
      }),
      "utf8"
    );

    const fromFile = readWebSearchConfig({ AI2NAO_WEB_SEARCH_CONFIG: path });
    expect(fromFile).toMatchObject({
      configured: true,
      apiKey: "file-key",
      configPath: path,
      defaultResults: 7,
      maxResults: 9,
    });

    const fromEnv = readWebSearchConfig({
      AI2NAO_WEB_SEARCH_CONFIG: path,
      BRAVE_SEARCH_API_KEY: "env-key",
    });
    expect(fromEnv.apiKey).toBe("env-key");
  });

  it("rejects unsupported web search config providers", () => {
    expect(parseWebSearchConfigJson(JSON.stringify({ provider: "other", apiKey: "x" }))).toBeNull();
  });

  it("accepts public queries and blocks obvious sensitive queries", () => {
    expect(sanitizeWebSearchQuery("  Brave   Search API docs ")).toBe("Brave Search API docs");
    expect(() => sanitizeWebSearchQuery("/Users/quincy/project secret")).toThrow(
      /sensitive/i
    );
    expect(() => sanitizeWebSearchQuery("email me at test@example.com")).toThrow(/sensitive/i);
    expect(() => sanitizeWebSearchQuery("sk-1234567890abcdefghijklmnop")).toThrow(/sensitive/i);
  });

  it("normalizes cache keys conservatively", () => {
    expect(normalizeCacheQuery("  Brave   Search API ")).toBe("brave search api");
    expect(normalizeCacheQuery("OpenAI web_search vs web search?")).toBe(
      "openai web_search vs web search?"
    );
  });
});

describe("BraveSearchProvider", () => {
  it("normalizes successful Brave web results", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        web: {
          results: [
            { title: " Brave API ", url: " https://example.com ", description: " Docs " },
            { title: "", url: "https://skip.example", description: "skip" },
          ],
        },
      })
    ) as unknown as typeof fetch;
    const provider = new BraveSearchProvider({ apiKey: "key", fetchImpl });
    const result = await provider.search({ query: "brave", count: 5 });
    expect(result.provider).toBe("brave");
    expect(result.results).toEqual([
      { title: "Brave API", url: "https://example.com", snippet: "Docs" },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps provider auth, rate limit, and malformed JSON errors", async () => {
    await expect(
      new BraveSearchProvider({
        apiKey: "key",
        fetchImpl: vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch,
      }).search({ query: "x", count: 1 })
    ).rejects.toBeInstanceOf(SearchProviderAuthError);

    await expect(
      new BraveSearchProvider({
        apiKey: "key",
        fetchImpl: vi.fn(async () => new Response("nope", { status: 429 })) as unknown as typeof fetch,
      }).search({ query: "x", count: 1 })
    ).rejects.toBeInstanceOf(SearchProviderRateLimitError);

    await expect(
      new BraveSearchProvider({
        apiKey: "key",
        fetchImpl: vi.fn(async () => new Response("{", { status: 200 })) as unknown as typeof fetch,
      }).search({ query: "x", count: 1 })
    ).rejects.toBeInstanceOf(SearchProviderParseError);
  });
});

describe("WebSearchMemoryCache", () => {
  it("returns hits before TTL and misses after expiry", () => {
    let now = 1000;
    const cache = new WebSearchMemoryCache<string>(() => now);
    cache.set("k", "v", 500);
    expect(cache.get("k")).toBe("v");
    now = 1600;
    expect(cache.get("k")).toBeNull();
  });
});

describe("webSearchService", () => {
  it("uses cache before provider and returns a stable evidence envelope", async () => {
    const provider: WebSearchProvider = {
      provider: "brave",
      search: vi.fn(async (): Promise<WebSearchProviderResponse> => ({
        provider: "brave",
        results: [{ title: "Title", url: "https://example.com", snippet: "Snippet" }],
      })),
    };
    const service = createWebSearchService({
      config: configWithKey(),
      provider,
      diagnostics: createWebSearchDiagnostics(),
      now: () => new Date("2026-05-17T00:00:00.000Z"),
    });

    const first = await service.search({ query: "Brave Search API", count: 1 });
    const second = await service.search({ query: " brave  search api ", count: 1 });

    expect(first).toMatchObject({
      ok: true,
      kind: "evidence",
      source: "web",
      evidence: [{ title: "Title", source: "web", provider: "brave" }],
      meta: { provider: "brave", cached: false },
    });
    expect(second).toMatchObject({ ok: true, meta: { cached: true } });
    expect(provider.search).toHaveBeenCalledTimes(1);
  });

  it("returns recoverable errors without calling provider for disabled or sensitive requests", async () => {
    const provider: WebSearchProvider = {
      provider: "brave",
      search: vi.fn(),
    };
    const service = createWebSearchService({
      config: configWithKey(),
      provider,
      diagnostics: createWebSearchDiagnostics(),
    });

    await expect(service.search({ query: "docs" }, { enabled: false })).resolves.toMatchObject({
      ok: false,
      code: "tool_unavailable",
      recoverable: true,
    });
    await expect(service.search({ query: "/Users/quincy/secret" })).resolves.toMatchObject({
      ok: false,
      code: "sensitive_query_blocked",
      recoverable: true,
    });
    expect(provider.search).not.toHaveBeenCalled();
  });
});

describe("web search routes", () => {
  it("serves status and search results through the same service", async () => {
    const app = new Hono();
    const service = createWebSearchService({
      config: configWithKey(),
      provider: {
        provider: "brave",
        search: vi.fn(async () => ({
          provider: "brave",
          results: [{ title: "Title", url: "https://example.com", snippet: "Snippet" }],
        })),
      },
      diagnostics: createWebSearchDiagnostics(),
    });
    registerWebSearchRoutes(app, service);

    const status = await app.request("/api/web-search/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ provider: "brave", configured: true });

    const res = await app.request("/api/web-search", {
      method: "POST",
      body: JSON.stringify({ query: "docs", count: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, source: "web" });
  });
});
