import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { syncModelPrices } from "../src/cost/modelsDevSync.js";
import {
  latestSyncedAt,
  listModelPrices,
  loadPriceMap,
} from "../src/cost/priceStore.js";
import { computeCost, priceFor } from "../src/cost/pricing.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-price-sync-"));
  return openDatabase(join(dir, "test.db"));
}

// Minimal models.dev api.json shape: provider → models → cost (per 1M tokens).
const FIXTURE = {
  anthropic: {
    id: "anthropic",
    models: {
      "claude-sonnet-4-6": {
        id: "anthropic/claude-sonnet-4-6",
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
    },
  },
  openai: {
    id: "openai",
    models: {
      "gpt-5.5": {
        id: "openai/gpt-5.5",
        cost: { input: 5, output: 30, cache_read: 0.5 }, // no cache_write
      },
      "weird-no-cost": { id: "openai/weird-no-cost" }, // no cost → skipped
    },
  },
  // a provider we don't sync — must be ignored
  google: { id: "google", models: { "gemini-x": { cost: { input: 1, output: 2 } } } },
};

const fetchFixture = async () => FIXTURE;

describe("syncModelPrices (models.dev)", () => {
  it("converts /1M → /token, maps cache_write→cacheCreation, skips no-cost, filters providers", async () => {
    const db = freshDb();
    const r = await syncModelPrices(db, {
      providers: ["anthropic", "openai"],
      nowIso: "2026-06-19T00:00:00Z",
      fetchJson: fetchFixture,
    });
    expect(r.status).toBe("success");
    expect(r.modelsUpserted).toBe(2); // sonnet + gpt-5.5 (weird-no-cost skipped)
    expect(r.skippedNoCost).toBe(1);

    const rows = listModelPrices(db);
    const sonnet = rows.find((x) => x.model_id === "claude-sonnet-4-6")!;
    // 3 / 1e6 = 3e-6 etc.
    expect(sonnet.input).toBeCloseTo(3e-6, 12);
    expect(sonnet.output).toBeCloseTo(15e-6, 12);
    expect(sonnet.cache_read).toBeCloseTo(0.3e-6, 12);
    expect(sonnet.cache_creation).toBeCloseTo(3.75e-6, 12); // cache_write → cacheCreation

    const gpt = rows.find((x) => x.model_id === "gpt-5.5")!;
    expect(gpt.input).toBeCloseTo(5e-6, 12);
    expect(gpt.cache_creation).toBe(0); // no cache_write → 0

    // google not synced
    expect(rows.some((x) => x.provider === "google")).toBe(false);
    expect(latestSyncedAt(db)).toBe("2026-06-19T00:00:00Z");
  });

  it("strips provider prefix from model id so priceFor matches a bare session model", async () => {
    const db = freshDb();
    await syncModelPrices(db, { fetchJson: fetchFixture, nowIso: "2026-06-19T00:00:00Z" });
    const map = loadPriceMap(db);
    // session model is bare "gpt-5.5"; stored id is bare too → priced.
    expect(priceFor("gpt-5.5", map)).not.toBeNull();
  });

  it("failed fetch → status failed, existing rows untouched", async () => {
    const db = freshDb();
    await syncModelPrices(db, { fetchJson: fetchFixture, nowIso: "2026-06-19T00:00:00Z" });
    const before = listModelPrices(db).length;
    const r = await syncModelPrices(db, {
      fetchJson: async () => {
        throw new Error("network down");
      },
    });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("network down");
    expect(listModelPrices(db).length).toBe(before); // not wiped
  });
});

describe("loadPriceMap — DB overlays vendored (synced wins)", () => {
  it("DB price overrides the vendored entry; DB-only model becomes priceable", async () => {
    const db = freshDb();
    // gpt-5.5 is NOT in the vendored map → unpriced before sync.
    expect(computeCost(
      { fresh: 1e6, cacheHit: 0, cacheCreation: 0, output: 0 },
      "gpt-5.5"
    ).priced).toBe(false);

    await syncModelPrices(db, { fetchJson: fetchFixture, nowIso: "2026-06-19T00:00:00Z" });
    const map = loadPriceMap(db);

    // After sync, gpt-5.5 prices from DB: 1e6 fresh × 5e-6 = $5.
    const r = computeCost(
      { fresh: 1e6, cacheHit: 0, cacheCreation: 0, output: 0 },
      "gpt-5.5",
      map
    );
    expect(r.priced).toBe(true);
    if (!r.priced) throw new Error("narrow");
    expect(r.usd).toBeCloseTo(5, 6);
  });
});
