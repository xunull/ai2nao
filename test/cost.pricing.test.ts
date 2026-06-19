import { describe, expect, it } from "vitest";
import {
  computeCost,
  MODEL_PRICES,
  priceFor,
  PRICE_SNAPSHOT_DATE,
} from "../src/cost/pricing.js";

describe("priceFor — model name normalization", () => {
  it("exact key match", () => {
    expect(priceFor("claude-opus-4-8")).toBe(MODEL_PRICES["claude-opus-4-8"]);
  });

  it("strips a trailing -YYYYMMDD date suffix (real Claude jsonl shape)", () => {
    // claude-haiku-4-5-20251001 → claude-haiku-4-5
    expect(priceFor("claude-haiku-4-5-20251001")).toBe(
      MODEL_PRICES["claude-haiku-4-5"]
    );
  });

  it("strips a provider prefix and a bedrock -vN:N suffix", () => {
    expect(priceFor("anthropic.claude-sonnet-4-6-v1:0")).toBe(
      MODEL_PRICES["claude-sonnet-4-6"]
    );
  });

  it("returns null for an unknown model (never guesses)", () => {
    expect(priceFor("gpt-5.5")).toBeNull(); // intentionally absent from snapshot
    expect(priceFor("some-future-model")).toBeNull();
    expect(priceFor(null)).toBeNull();
    expect(priceFor("")).toBeNull();
  });
});

describe("computeCost", () => {
  it("prices each component at its model rate (cache_read ~10x cheaper)", () => {
    // sonnet: input 3e-6, output 1.5e-5, cacheRead 3e-7, cacheCreation 3.75e-6
    const r = computeCost(
      { fresh: 1000, cacheCreation: 2000, cacheHit: 10000, output: 500 },
      "claude-sonnet-4-6"
    );
    expect(r.priced).toBe(true);
    if (!r.priced) throw new Error("type narrow");
    // 1000*3e-6 + 2000*3.75e-6 + 10000*3e-7 + 500*1.5e-5
    // = 0.003 + 0.0075 + 0.003 + 0.0075 = 0.021
    expect(r.usd).toBeCloseTo(0.021, 9);
  });

  it("unknown model → unpriced (usd 0, priced false) — never $0-as-priced", () => {
    const r = computeCost(
      { fresh: 1e6, cacheCreation: 0, cacheHit: 0, output: 1e6 },
      "gpt-5.5"
    );
    expect(r.priced).toBe(false);
    expect(r.usd).toBe(0);
  });

  it("Codex shape (no cache_creation) prices fine", () => {
    const r = computeCost(
      { fresh: 100, cacheCreation: 0, cacheHit: 900, output: 50 },
      "claude-opus-4-8"
    );
    expect(r.priced).toBe(true);
  });
});

describe("snapshot metadata", () => {
  it("exposes a snapshot date for honest UI labeling", () => {
    expect(PRICE_SNAPSHOT_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
