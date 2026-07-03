/**
 * 通用时间窗口 / 分桶原语(中立模块,与业务无关)。
 *
 * 原住 `workTokensTrend/`,2026-07-03 抽出:tokens-trend、gitChurn、agent-messages
 * 分析图都复用同一套「窗口 → 粒度 → 桶枚举」逻辑。token 专属 DTO 仍留 workTokensTrend。
 */

export const WINDOW_KEYS = ["1d", "3d", "1w", "2w", "1m", "3m", "6m"] as const;
export type WindowKey = (typeof WINDOW_KEYS)[number];

export type BucketGranularity = "hour" | "3hour" | "day" | "week";

/**
 * Window → bucket granularity mapping (唯一真相)。
 *   1d  → hour    (24 桶)
 *   3d  → 3hour   (24 桶)
 *   1w  → day     ( 7 桶)
 *   2w  → day     (14 桶)
 *   1m  → day     (28-31 桶)
 *   3m  → week    (~13 桶)
 *   6m  → week    (~26 桶)
 *   month → day   (28-31 桶)
 */
export function windowToGranularity(window: WindowKey): BucketGranularity {
  switch (window) {
    case "1d":
      return "hour";
    case "3d":
      return "3hour";
    case "1w":
    case "2w":
    case "1m":
      return "day";
    case "3m":
    case "6m":
      return "week";
  }
}

export function windowToDays(window: WindowKey): number {
  switch (window) {
    case "1d":
      return 1;
    case "3d":
      return 3;
    case "1w":
      return 7;
    case "2w":
      return 14;
    case "1m":
      return 30;
    case "3m":
      return 90;
    case "6m":
      return 180;
  }
}

export function isWindowKey(raw: unknown): raw is WindowKey {
  return (
    typeof raw === "string" &&
    (WINDOW_KEYS as readonly string[]).includes(raw)
  );
}

/** YYYY-MM (e.g. "2026-06"). */
export type MonthKey = string;

export function isMonthKey(raw: unknown): raw is MonthKey {
  return typeof raw === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw);
}

/** Maximum month-picker depth (24 months back). */
export const MONTH_PICKER_MAX_DEPTH = 24;
