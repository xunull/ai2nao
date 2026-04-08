import { describe, expect, it } from "vitest";
import {
  calendarDayLocalFromChromeDownload,
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

  it("calendarDayLocalFromChromeDownload uses end_time when positive", () => {
    const dayUs = 86_400 * 1_000_000;
    expect(calendarDayLocalFromChromeDownload(dayUs, 0)).toBe(
      calendarDayLocalFromChromeUs(dayUs)
    );
  });

  it("calendarDayLocalFromChromeDownload falls back to start_time when end invalid", () => {
    const startUs = 86_400 * 2 * 1_000_000;
    expect(calendarDayLocalFromChromeDownload(0, startUs)).toBe(
      calendarDayLocalFromChromeUs(startUs)
    );
    expect(calendarDayLocalFromChromeDownload(undefined, startUs)).toBe(
      calendarDayLocalFromChromeUs(startUs)
    );
  });
});
