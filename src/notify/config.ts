import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";

/**
 * Outbound notification config — `~/.ai2nao/notify.json` (0600).
 *
 * This is the ONLY place ai2nao is configured to send data off the machine, so
 * the file holds the webhook URL + signing secret and is never committed, never
 * written to the DB, and never surfaced through the API. Missing file = feature
 * off (the push task silently skips), matching the github/rag/llm-chat config
 * pattern (see src/github/config.ts).
 *
 * Shape:
 * {
 *   "feishu": { "enabled": true, "webhookUrl": "https://open.feishu.cn/...", "secret": "..." },
 *   "daily":  { "enabled": true, "atHour": 21 },
 *   "weekly": { "enabled": true, "atHour": 9, "weekday": 1 }
 * }
 */
export type NotifyConfig = {
  feishu: { enabled: boolean; webhookUrl: string; secret?: string };
  daily: { enabled: boolean; atHour: number };
  /** weekday: 1=Mon … 7=Sun (the day the weekly report is SENT). */
  weekly: { enabled: boolean; atHour: number; weekday: number };
};

export const DEFAULT_DAILY_HOUR = 21;
export const DEFAULT_WEEKLY_HOUR = 9;
export const DEFAULT_WEEKLY_WEEKDAY = 1; // Monday

export function defaultNotifyConfigPath(): string {
  const home = homedir();
  if (!home) return ".ai2nao/notify.json";
  return `${home}/.ai2nao/notify.json`;
}

function isGroupOrOtherReadable(path: string): boolean {
  try {
    return (statSync(path).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

function clampHour(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? Math.trunc(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : fallback;
}

export function parseNotifyConfigJson(raw: string): NotifyConfig | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, any>;
  const url = typeof o.feishu?.webhookUrl === "string" ? o.feishu.webhookUrl.trim() : "";
  if (!url) return null; // no webhook = nothing to send to
  const weekdayRaw = Math.trunc(Number(o.weekly?.weekday));
  return {
    feishu: {
      enabled: o.feishu?.enabled !== false,
      webhookUrl: url,
      secret:
        typeof o.feishu?.secret === "string" && o.feishu.secret.trim()
          ? o.feishu.secret.trim()
          : undefined,
    },
    daily: {
      enabled: o.daily?.enabled !== false,
      atHour: clampHour(o.daily?.atHour, DEFAULT_DAILY_HOUR),
    },
    weekly: {
      enabled: o.weekly?.enabled !== false,
      atHour: clampHour(o.weekly?.atHour, DEFAULT_WEEKLY_HOUR),
      weekday:
        Number.isFinite(weekdayRaw) && weekdayRaw >= 1 && weekdayRaw <= 7
          ? weekdayRaw
          : DEFAULT_WEEKLY_WEEKDAY,
    },
  };
}

/** null when absent / unreadable / no webhook — caller treats that as "feature off". */
export function readNotifyConfig(path = defaultNotifyConfigPath()): NotifyConfig | null {
  if (!existsSync(path)) return null;
  if (isGroupOrOtherReadable(path)) {
    console.error(
      `warning: ${path} is group/other-readable; run \`chmod 0600 ${path}\` to protect your webhook secret.`
    );
  }
  try {
    return parseNotifyConfigJson(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
