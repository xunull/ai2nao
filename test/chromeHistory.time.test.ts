import { describe, expect, it } from "vitest";
import {
  calendarDayLocalFromChromeUs,
  chromeWebkitUsToUnixMs,
} from "../src/chromeHistory/time.js";

describe("chromeHistory time", () => {
  it("maps WebKit epoch 0 to 1601-01-01 UTC in unix ms", () => {
    const ms = chromeWebkitUsToUnixMs(0);
    expect(ms).toBe(Date.UTC(1601, 0, 1));
  });

  it("adds one day in microseconds", () => {
    const dayUs = 86_400 * 1_000_000;
    const ms = chromeWebkitUsToUnixMs(dayUs);
    expect(ms).toBe(Date.UTC(1601, 0, 2));
  });

  it("calendarDayLocalFromChromeUs returns YYYY-MM-DD", () => {
    const s = calendarDayLocalFromChromeUs(0);
    expect(/^\d{4}-\d{2}-\d{2}$/.test(s)).toBe(true);
  });
});
