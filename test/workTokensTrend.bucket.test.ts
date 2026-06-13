import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  __bucketExpr,
  iterateBuckets,
  monthToRange,
  assertMonthInDepth,
  previousWindowRange,
  windowToRange,
} from "../src/workTokensTrend/bucket.js";
import {
  windowToGranularity,
  windowToDays,
  isWindowKey,
  isMonthKey,
} from "../src/workTokensTrend/types.js";

const PRIOR_TZ = process.env.TZ;
beforeAll(() => {
  // Pin TZ so week-bucket edge cases stay deterministic on CI.
  process.env.TZ = "Asia/Shanghai";
});
afterAll(() => {
  process.env.TZ = PRIOR_TZ;
});

describe("windowToGranularity", () => {
  it("maps each WindowKey to its expected bucket granularity", () => {
    expect(windowToGranularity("1d")).toBe("hour");
    expect(windowToGranularity("3d")).toBe("3hour");
    expect(windowToGranularity("1w")).toBe("day");
    expect(windowToGranularity("2w")).toBe("day");
    expect(windowToGranularity("1m")).toBe("day");
    expect(windowToGranularity("3m")).toBe("week");
    expect(windowToGranularity("6m")).toBe("week");
  });
});

describe("windowToDays", () => {
  it("matches the seven supported windows", () => {
    expect(windowToDays("1d")).toBe(1);
    expect(windowToDays("3d")).toBe(3);
    expect(windowToDays("1w")).toBe(7);
    expect(windowToDays("2w")).toBe(14);
    expect(windowToDays("1m")).toBe(30);
    expect(windowToDays("3m")).toBe(90);
    expect(windowToDays("6m")).toBe(180);
  });
});

describe("isWindowKey / isMonthKey type guards", () => {
  it("isWindowKey accepts the 7 keys and rejects everything else", () => {
    for (const k of ["1d", "3d", "1w", "2w", "1m", "3m", "6m"]) {
      expect(isWindowKey(k)).toBe(true);
    }
    for (const bad of ["", "2d", "99d", null, undefined, 7, {}, "1W"]) {
      expect(isWindowKey(bad)).toBe(false);
    }
  });

  it("isMonthKey accepts YYYY-MM with valid months 01..12", () => {
    expect(isMonthKey("2026-01")).toBe(true);
    expect(isMonthKey("2026-06")).toBe(true);
    expect(isMonthKey("2026-12")).toBe(true);
    expect(isMonthKey("2026-13")).toBe(false);
    expect(isMonthKey("2026-00")).toBe(false);
    expect(isMonthKey("26-06")).toBe(false);
    expect(isMonthKey("2026/06")).toBe(false);
    expect(isMonthKey(null)).toBe(false);
  });
});

describe("bucketExpr SQL (F3 enum-only signature)", () => {
  it("returns hardcoded SQL fragments per granularity", () => {
    expect(__bucketExpr("hour")).toContain("strftime('%Y-%m-%d %H:00:00'");
    expect(__bucketExpr("hour")).toContain("'localtime'");
    expect(__bucketExpr("3hour")).toContain("/ 3) * 3");
    expect(__bucketExpr("day")).toContain("strftime('%Y-%m-%d'");
    expect(__bucketExpr("week")).toContain("date(last_updated_at, 'localtime'");
    expect(__bucketExpr("week")).toContain("+ 6) % 7");
  });
});

describe("iterateBuckets", () => {
  it("emits contiguous hour buckets for a 24h window", () => {
    const from = new Date(2026, 5, 10, 0, 0, 0, 0); // 2026-06-10 00:00 local
    const to = new Date(2026, 5, 11, 0, 0, 0, 0); // 2026-06-11 00:00
    const buckets = iterateBuckets(from, to, "hour");
    expect(buckets).toHaveLength(24);
    expect(buckets[0].key).toBe("2026-06-10 00:00:00");
    expect(buckets[23].key).toBe("2026-06-10 23:00:00");
    expect(buckets[0].start.getTime()).toBe(from.getTime());
    expect(buckets[23].end.getTime()).toBe(to.getTime());
  });

  it("emits 8 3-hour buckets for a 24h window", () => {
    const from = new Date(2026, 5, 10, 0, 0, 0, 0);
    const to = new Date(2026, 5, 11, 0, 0, 0, 0);
    const buckets = iterateBuckets(from, to, "3hour");
    expect(buckets).toHaveLength(8);
    expect(buckets[0].key).toBe("2026-06-10 00:00:00");
    expect(buckets[1].key).toBe("2026-06-10 03:00:00");
    expect(buckets[7].key).toBe("2026-06-10 21:00:00");
  });

  it("emits day buckets for a 7d window", () => {
    const from = new Date(2026, 5, 3, 0, 0, 0, 0);
    const to = new Date(2026, 5, 10, 0, 0, 0, 0);
    const buckets = iterateBuckets(from, to, "day");
    expect(buckets).toHaveLength(7);
    expect(buckets[0].key).toBe("2026-06-03");
    expect(buckets[6].key).toBe("2026-06-09");
  });

  // F4 case 1: cross-month week boundary
  it("T-A1 (F4): 2026-03-01 (Sunday) week bucket anchors to 2026-02-23 (Monday)", () => {
    // Range covers 3 calendar weeks: [Feb 23, March 16) Mondays.
    const from = new Date(2026, 1, 23, 0, 0, 0, 0); // Feb 23 Monday
    const to = new Date(2026, 2, 16, 0, 0, 0, 0); // March 16 Monday (3 weeks later)
    const buckets = iterateBuckets(from, to, "week");
    expect(buckets).toHaveLength(3);
    expect(buckets[0].key).toBe("2026-02-23"); // Mon
    expect(buckets[1].key).toBe("2026-03-02"); // Mon AFTER Sunday March 1
    expect(buckets[2].key).toBe("2026-03-09");
    // Bucket 0 covers [Feb 23, Mar 2). A session timestamped Sun Mar 1
    // belongs to bucket 0, not bucket 1.
    expect(buckets[0].end.getTime()).toBe(buckets[1].start.getTime());
    const sunMar1 = new Date(2026, 2, 1, 10, 0, 0, 0);
    expect(sunMar1.getTime() >= buckets[0].start.getTime()).toBe(true);
    expect(sunMar1.getTime() < buckets[0].end.getTime()).toBe(true);
  });

  // F4 case 2: cross-year
  it("T-A2 (F4): 2024-12-30 (Monday) week bucket starts a new week on the same day", () => {
    const from = new Date(2024, 11, 30, 0, 0, 0, 0); // Dec 30 Monday
    const to = new Date(2025, 0, 13, 0, 0, 0, 0); // Jan 13 Monday (2 weeks)
    const buckets = iterateBuckets(from, to, "week");
    expect(buckets).toHaveLength(2);
    expect(buckets[0].key).toBe("2024-12-30");
    expect(buckets[1].key).toBe("2025-01-06"); // calendar-aware, no slip
  });

  // F4 case 3: late-Monday timestamp must NOT slip into Tuesday's bucket
  it("T-A3 (F4): a session at Mon 23:59:59 stays in Monday's week bucket", () => {
    // Build a range from this Monday morning to the next-next Monday.
    const monStart = new Date(2026, 5, 8, 0, 0, 0, 0); // 2026-06-08 Mon
    const nextNextMon = new Date(2026, 5, 22, 0, 0, 0, 0); // 2026-06-22 Mon
    const buckets = iterateBuckets(monStart, nextNextMon, "week");
    expect(buckets).toHaveLength(2);
    expect(buckets[0].key).toBe("2026-06-08");
    expect(buckets[1].key).toBe("2026-06-15");
    // 23:59:59 still falls inside bucket 0 because anchorBucketStart of a
    // Monday-late timestamp is that same Monday 00:00.
    const lateMon = new Date(2026, 5, 8, 23, 59, 59, 0);
    expect(lateMon.getTime() >= buckets[0].start.getTime()).toBe(true);
    expect(lateMon.getTime() < buckets[0].end.getTime()).toBe(true);
  });

  // F4 last-bucket policy: when to > now, keep the bucket whole (no truncation).
  it("T-A6 (F4): last bucket is NOT truncated when bucketEnd > now", () => {
    // Pick `to` mid-hour. Hourly granularity, so the last hour bucket
    // contains times beyond `to`. iterateBuckets's contract is
    // strictly [from, to) but the bucket entry itself has full duration.
    const from = new Date(2026, 5, 10, 0, 0, 0, 0);
    const to = new Date(2026, 5, 10, 5, 30, 0, 0); // 5:30 mid-hour
    const buckets = iterateBuckets(from, to, "hour");
    // Iteration emits buckets whose START is < to:
    //   00:00, 01:00, 02:00, 03:00, 04:00, 05:00 (5:00 < 5:30 < 6:00)
    // → 6 buckets, last one ENDS at 06:00 which IS > to.
    expect(buckets.length).toBe(6);
    const last = buckets[buckets.length - 1];
    expect(last.start.getHours()).toBe(5);
    expect(last.end.getHours()).toBe(6);
    expect(last.end.getTime() > to.getTime()).toBe(true);
  });
});

describe("monthToRange + assertMonthInDepth", () => {
  it("monthToRange returns [first-of-month, first-of-next-month)", () => {
    const r = monthToRange("2026-06");
    expect(r.from.getFullYear()).toBe(2026);
    expect(r.from.getMonth()).toBe(5);
    expect(r.from.getDate()).toBe(1);
    expect(r.from.getHours()).toBe(0);
    expect(r.to.getFullYear()).toBe(2026);
    expect(r.to.getMonth()).toBe(6);
    expect(r.to.getDate()).toBe(1);
  });

  it("monthToRange handles January (year rollover, no underflow)", () => {
    const r = monthToRange("2026-01");
    expect(r.from.getMonth()).toBe(0);
    expect(r.to.getMonth()).toBe(1);
  });

  it("monthToRange throws on bad format", () => {
    expect(() => monthToRange("2026-13")).toThrow(/invalid month key/);
    expect(() => monthToRange("not-a-month")).toThrow();
  });

  it("assertMonthInDepth accepts month within the last 24 months", () => {
    const now = new Date(2026, 5, 10);
    expect(() => assertMonthInDepth("2026-06", now)).not.toThrow();
    expect(() => assertMonthInDepth("2024-06", now)).not.toThrow(); // 24m back
    expect(() => assertMonthInDepth("2025-01", now)).not.toThrow();
  });

  it("assertMonthInDepth rejects month older than 24 months back", () => {
    const now = new Date(2026, 5, 10);
    expect(() => assertMonthInDepth("2024-05", now)).toThrow(/older than 24/);
    expect(() => assertMonthInDepth("2020-01", now)).toThrow();
  });
});

describe("windowToRange + previousWindowRange", () => {
  it("windowToRange returns [now - days * 86400e3, now)", () => {
    const now = new Date(2026, 5, 10, 12, 0, 0, 0);
    const r = windowToRange("1w", now);
    expect(r.to.getTime()).toBe(now.getTime());
    expect(now.getTime() - r.from.getTime()).toBe(7 * 86400000);
  });

  it("T-A5 (F2): previousWindowRange is strictly non-overlapping with current", () => {
    const from = new Date(2026, 5, 3); // 6/3
    const to = new Date(2026, 5, 10); // 6/10
    const prev = previousWindowRange(from, to);
    expect(prev.to.getTime()).toBe(from.getTime()); // prev.to == current.from
    expect(prev.from.getTime()).toBe(from.getTime() - (to.getTime() - from.getTime()));
    expect(prev.from.getTime() < prev.to.getTime()).toBe(true);
  });
});
