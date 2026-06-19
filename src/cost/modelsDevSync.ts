import type Database from "better-sqlite3";
import { replaceProviderPrices, type ModelPriceRow } from "./priceStore.js";

/**
 * Sync model prices from models.dev (api.json) into the model_prices table.
 *
 * models.dev shape (verified): top-level keyed by provider id; each provider has
 * a `.models` object; each model has `.cost { input, output, cache_read,
 * cache_write }` in USD per 1M tokens. We divide by 1e6 (→ per token) and map
 * cache_write → cache_creation. Only anthropic + openai by default.
 *
 * Honesty: a model with no usable `cost` (missing input/output) is SKIPPED — we
 * never store a 0-priced model (that would mis-price it as free). A failed fetch
 * leaves existing rows untouched (upsert per provider is non-destructive on
 * failure: we only write providers we successfully parsed).
 */

const DEFAULT_URL = "https://models.dev/api.json";
const DEFAULT_PROVIDERS = ["anthropic", "openai"];
const DEFAULT_TIMEOUT_MS = 8_000;
const PER_MILLION = 1_000_000;

export type ModelsDevSyncOptions = {
  url?: string;
  providers?: string[];
  timeoutMs?: number;
  /** Override clock (tests). */
  nowIso?: string;
  /** Inject the fetch (tests) — returns the parsed JSON. */
  fetchJson?: (url: string, signal: AbortSignal) => Promise<unknown>;
};

export type ModelsDevSyncResult = {
  status: "success" | "partial" | "failed";
  providersUpdated: string[];
  modelsUpserted: number;
  skippedNoCost: number;
  syncedAt: string;
  error?: string;
};

function asObj(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Strip a leading `<provider>/` from a model id so it matches priceFor keys. */
function bareModelId(rawId: string, fallbackKey: string): string {
  const id = rawId || fallbackKey;
  const slash = id.indexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

async function defaultFetchJson(
  url: string,
  signal: AbortSignal
): Promise<unknown> {
  const r = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function syncModelPrices(
  db: Database.Database,
  options: ModelsDevSyncOptions = {}
): Promise<ModelsDevSyncResult> {
  const url = options.url ?? DEFAULT_URL;
  const providers = options.providers ?? DEFAULT_PROVIDERS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const syncedAt = options.nowIso ?? new Date().toISOString();
  const fetchJson = options.fetchJson ?? defaultFetchJson;

  let root: Record<string, unknown> | null = null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    root = asObj(await fetchJson(url, ac.signal));
  } catch (e) {
    return {
      status: "failed",
      providersUpdated: [],
      modelsUpserted: 0,
      skippedNoCost: 0,
      syncedAt,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
  if (!root) {
    return {
      status: "failed",
      providersUpdated: [],
      modelsUpserted: 0,
      skippedNoCost: 0,
      syncedAt,
      error: "models.dev response was not an object",
    };
  }

  const providersUpdated: string[] = [];
  let modelsUpserted = 0;
  let skippedNoCost = 0;
  let missingProviders = 0;

  for (const provider of providers) {
    const providerObj = asObj(root[provider]);
    const models = providerObj ? asObj(providerObj.models) : null;
    if (!models) {
      missingProviders++;
      continue;
    }
    const rows: ModelPriceRow[] = [];
    for (const [key, rawModel] of Object.entries(models)) {
      const model = asObj(rawModel);
      const cost = model ? asObj(model.cost) : null;
      if (!cost) {
        skippedNoCost++;
        continue;
      }
      const input = num(cost.input);
      const output = num(cost.output);
      if (input == null || output == null) {
        skippedNoCost++;
        continue;
      }
      const modelId = bareModelId(
        typeof model?.id === "string" ? model.id : "",
        key
      );
      rows.push({
        provider,
        model_id: modelId,
        input: input / PER_MILLION,
        output: output / PER_MILLION,
        cache_read: (num(cost.cache_read) ?? 0) / PER_MILLION,
        cache_creation: (num(cost.cache_write) ?? 0) / PER_MILLION,
        source: "models.dev",
        synced_at: syncedAt,
      });
    }
    replaceProviderPrices(db, provider, rows);
    providersUpdated.push(provider);
    modelsUpserted += rows.length;
  }

  const status =
    missingProviders === providers.length
      ? "failed"
      : missingProviders > 0
        ? "partial"
        : "success";
  return {
    status,
    providersUpdated,
    modelsUpserted,
    skippedNoCost,
    syncedAt,
    error:
      missingProviders > 0
        ? `${missingProviders} provider(s) missing from models.dev response`
        : undefined,
  };
}
