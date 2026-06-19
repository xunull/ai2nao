import type Database from "better-sqlite3";
import { MODEL_PRICES, type ModelPrice, type PriceMap } from "./pricing.js";

/** A synced price row (USD per token). */
export type ModelPriceRow = {
  provider: string;
  model_id: string;
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  source: string;
  synced_at: string;
};

/** Replace all synced prices for one provider (delete-then-insert in a tx). */
export function replaceProviderPrices(
  db: Database.Database,
  provider: string,
  rows: ModelPriceRow[]
): void {
  const del = db.prepare("DELETE FROM model_prices WHERE provider = ?");
  const ins = db.prepare(
    `INSERT INTO model_prices
       (provider, model_id, input, output, cache_read, cache_creation, source, synced_at)
     VALUES (@provider, @model_id, @input, @output, @cache_read, @cache_creation, @source, @synced_at)`
  );
  const tx = db.transaction(() => {
    del.run(provider);
    for (const r of rows) ins.run(r);
  });
  tx();
}

export function listModelPrices(db: Database.Database): ModelPriceRow[] {
  return db
    .prepare(
      `SELECT provider, model_id, input, output, cache_read, cache_creation, source, synced_at
       FROM model_prices`
    )
    .all() as ModelPriceRow[];
}

/**
 * Build the effective price map: the vendored static snapshot as seed/fallback,
 * overlaid by synced DB rows (synced wins — fresher). Keyed by model_id, which
 * `priceFor` normalizes the session model against.
 */
export function loadPriceMap(db: Database.Database): PriceMap {
  const map: PriceMap = { ...MODEL_PRICES };
  for (const r of listModelPrices(db)) {
    const entry: ModelPrice = {
      input: r.input,
      output: r.output,
      cacheRead: r.cache_read,
      cacheCreation: r.cache_creation,
    };
    map[r.model_id] = entry;
  }
  return map;
}

/** Most recent synced_at across all rows, or null when never synced. */
export function latestSyncedAt(db: Database.Database): string | null {
  const row = db
    .prepare("SELECT MAX(synced_at) AS latest FROM model_prices")
    .get() as { latest: string | null };
  return row.latest ?? null;
}
