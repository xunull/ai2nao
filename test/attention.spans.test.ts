import { describe, expect, it } from "vitest";
import {
  localDayOf,
  splitAtLocalMidnight,
  toSpans,
  type SourceRow,
} from "../src/attention/spans.js";

const at = (
  y: number,
  mo: number,
  d: number,
  h: number,
  mi = 0,
  s = 0
): number => new Date(y, mo - 1, d, h, mi, s, 0).getTime();

const row = (over: Partial<SourceRow> = {}): SourceRow => ({
  rowId: 1,
  bundleId: "com.example.app-1",
  startMs: at(2026, 8, 10, 14, 0),
  endMs: at(2026, 8, 10, 14, 30),
  tzOffsetS: 28800,
  ...over,
});

describe("splitAtLocalMidnight", () => {
  it("leaves a span inside one day alone", () => {
    const parts = splitAtLocalMidnight(at(2026, 8, 10, 9), at(2026, 8, 10, 17));
    expect(parts).toHaveLength(1);
  });

  it("cuts a span that crosses midnight into two", () => {
    const start = at(2026, 8, 9, 23, 40);
    const end = at(2026, 8, 10, 1, 20);
    const parts = splitAtLocalMidnight(start, end);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.endMs).toBe(at(2026, 8, 10, 0));
    expect(parts[1]!.startMs).toBe(at(2026, 8, 10, 0));
    // The whole point: the two halves still add up to the original.
    const total =
      parts[0]!.endMs - parts[0]!.startMs + (parts[1]!.endMs - parts[1]!.startMs);
    expect(total).toBe(end - start);
    expect(total).toBe(100 * 60_000);
  });

  it("cuts a multi-day span at every boundary", () => {
    const parts = splitAtLocalMidnight(at(2026, 8, 9, 22), at(2026, 8, 12, 3));
    expect(parts).toHaveLength(4);
    expect(parts.map((p) => localDayOf(p.startMs))).toEqual([
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
    ]);
  });

  it("does not spin on a zero-length or inverted span", () => {
    expect(splitAtLocalMidnight(1000, 1000)).toHaveLength(1);
    expect(splitAtLocalMidnight(2000, 1000)).toHaveLength(1);
  });
});

describe("toSpans", () => {
  it("keeps a normal row as a single part", () => {
    const [s] = toSpans([row()]);
    expect(s).toMatchObject({
      sourceRowId: 1,
      partIndex: 0,
      durationMs: 30 * 60_000,
      localDay: "2026-08-10",
      tzOffsetS: 28800,
    });
  });

  it("drops zero-length flickers by default", () => {
    // Measured: 153 of 10343 real rows have end == start. They are an app
    // taking focus and losing it in the same instant, not a gap to be patched.
    const t = at(2026, 8, 10, 12);
    expect(toSpans([row({ startMs: t, endMs: t })])).toEqual([]);
  });

  it("keeps short-but-real rows by default", () => {
    // Two seconds is short, but calling it "not attention" is a product
    // judgement that belongs in aggregation, not in ingestion.
    const t = at(2026, 8, 10, 12);
    const out = toSpans([row({ startMs: t, endMs: t + 2000 })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.durationMs).toBe(2000);
  });

  it("honours an explicit minimum duration", () => {
    const t = at(2026, 8, 10, 12);
    const out = toSpans([row({ startMs: t, endMs: t + 2000 })], {
      minDurationMs: 5000,
    });
    expect(out).toEqual([]);
  });

  it("applies the bundle allowlist", () => {
    const out = toSpans(
      [row({ bundleId: "com.example.keep" }), row({ bundleId: "com.example.drop" })],
      { allowBundles: new Set(["com.example.keep"]) }
    );
    expect(out.map((s) => s.bundleId)).toEqual(["com.example.keep"]);
  });

  it("numbers the parts of a midnight-crossing row so neither is lost", () => {
    // D3 (source row as idempotency key) and D9 (split at midnight) collide:
    // both halves share one source row id. part_index is what keeps the second
    // half from being swallowed by the UNIQUE constraint.
    const out = toSpans([
      row({ rowId: 42, startMs: at(2026, 8, 9, 23, 40), endMs: at(2026, 8, 10, 1, 20) }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((s) => [s.sourceRowId, s.partIndex, s.localDay])).toEqual([
      [42, 0, "2026-08-09"],
      [42, 1, "2026-08-10"],
    ]);
    expect(out[0]!.durationMs + out[1]!.durationMs).toBe(100 * 60_000);
  });

  it("skips rows with non-finite timestamps", () => {
    // knowledgeC really does carry garbage: 29 rows in a sync-bookmark stream
    // decode to the year 0000. Ingestion must refuse them, not store them.
    const out = toSpans([
      row({ startMs: Number.NaN }),
      row({ endMs: Number.POSITIVE_INFINITY }),
    ]);
    expect(out).toEqual([]);
  });
});
