import type {
  ProviderSnapshot,
  ProviderSnapshotItem,
  ProviderSyncConfig,
  ProviderUsageSource,
} from "./types.js";

/**
 * Kimi Code (编程套餐 / Coding Plan) remaining-quota SNAPSHOT source — the
 * equivalent of MiniMax's `/v1/token_plan/remains`. Reads the per-window quota
 * (a short rolling window like 5h + an overall/plan window), NOT per-request
 * billing history (Kimi's coding plan exposes no such thing, so there is no
 * history link like MiniMax's `/account/amount`).
 *
 * Endpoint is UNDOCUMENTED and reverse-engineered (the Kimi CLI's own usage
 * call): `GET https://api.kimi.com/coding/v1/usages`, falling back to `/usage`
 * (singular) on 404. Auth is a **Kimi Code Coding-Plan key** (`sk-kimi-…`),
 * which is DISTINCT from the open-platform key (`sk-…`) — the two are not
 * interchangeable; an open-platform key returns `REASON_INVALID_AUTH_TOKEN`.
 * The request must carry a `User-Agent: KimiCLI/…` header or it may be refused.
 *
 * Real response (verified 2026-07-24, a Coding-Plan key):
 *   { usage: {limit:"100", remaining:"100", resetTime:"…Z"},          // overall/plan window
 *     limits: [ { window:{duration:300, timeUnit:"TIME_UNIT_MINUTE"},  // 300min = 5h window
 *                 detail:{limit:"100", remaining:"100", resetTime:"…Z"} } ],
 *     parallel:{limit:"10"}, authentication:{scope:"FEATURE_CODING"},
 *     membership:{level:"LEVEL_TRIAL"}, subType:"TYPE_PURCHASE" }
 *
 * Notes that drive parsing: numbers arrive as STRINGS ("100"); the payload gives
 * `remaining` (not `used`), so remainingPercent = remaining/limit*100 maps
 * straight onto the snapshot model; a community-observed `data[]` list form is
 * also tolerated. Parsing is defensive and the raw response is always kept.
 */

const BASE = "https://api.kimi.com/coding/v1";
const ENDPOINT = `${BASE}/usages`;
const FALLBACK = `${BASE}/usage`;
const USER_AGENT = "KimiCLI/1.6";
const TIMEOUT_MS = 12_000;

function asObj(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
/** Kimi sends numbers as strings ("100"); accept both, reject junk. */
function numLoose(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
/** resetTime is ISO (may carry microseconds) or epoch; → normalized ISO, or null. */
function normalizeReset(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const n = numLoose(v);
  if (n != null && n > 0) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  return null;
}

/** Duration+unit → human window key (stable id) / zh label. duration is minutes-ish. */
function windowKey(window: Record<string, unknown> | null, i: number): string {
  const d = window ? numLoose(window.duration) : null;
  const u = (window ? str(window.timeUnit) ?? str(window.time_unit) : null)?.toUpperCase() ?? "";
  if (d == null) return `w${i}`;
  if (u.includes("MINUTE")) return d % 60 === 0 ? `${d / 60}h` : `${d}m`;
  if (u.includes("HOUR")) return `${d}h`;
  if (u.includes("DAY")) return `${d}d`;
  if (u.includes("MONTH")) return `${d}mo`;
  return `${d}s`;
}
function windowLabel(window: Record<string, unknown> | null, i: number): string {
  const d = window ? numLoose(window.duration) : null;
  const u = (window ? str(window.timeUnit) ?? str(window.time_unit) : null)?.toUpperCase() ?? "";
  if (d == null) return `窗口 ${i + 1}`;
  if (u.includes("MINUTE"))
    return d >= 60 && d % 60 === 0 ? `${d / 60} 小时窗口` : `${d} 分钟窗口`;
  if (u.includes("HOUR")) return `${d} 小时窗口`;
  if (u.includes("DAY")) return `${d} 天窗口`;
  if (u.includes("MONTH")) return `${d} 月窗口`;
  return `${d} 秒窗口`;
}

/** One quota block ({limit, remaining, resetTime}) → a snapshot item, or null. */
function toItem(
  data: Record<string, unknown>,
  key: string,
  label: string,
  kind: "overall" | "window",
  window?: Record<string, unknown> | null
): ProviderSnapshotItem | null {
  const limit = numLoose(data.limit ?? data.limit_amount);
  let remaining = numLoose(data.remaining);
  const used = numLoose(data.used ?? data.used_amount);
  if (remaining == null && used != null && limit != null) remaining = limit - used;
  if (limit == null && remaining == null) return null;
  const remainingPercent =
    limit != null && limit > 0 && remaining != null
      ? Math.round((remaining / limit) * 100)
      : null;
  return {
    key,
    label,
    remainingPercent,
    resetAt: normalizeReset(data.resetTime ?? data.reset_at ?? data.reset_time),
    detail: {
      kind,
      limit,
      remaining,
      used: limit != null && remaining != null ? limit - remaining : used,
      ...(window
        ? {
            window: {
              duration: numLoose(window.duration),
              timeUnit: str(window.timeUnit) ?? str(window.time_unit),
            },
          }
        : {}),
    },
  };
}

/** Parse a Kimi Code /usages body into snapshot items (exported for tests). */
export function parseKimiUsages(body: unknown): ProviderSnapshot {
  const root = asObj(body);
  const items: ProviderSnapshotItem[] = [];
  if (!root) return { items, raw: body };

  // Tolerated form: a flat `data[]` list (community-observed; model_name "all"
  // is the overall summary). This account returns the usage+limits form below.
  if (Array.isArray(root.data)) {
    root.data.forEach((raw, i) => {
      const m = asObj(raw);
      if (!m) return;
      const isAll = str(m.model_name) === "all";
      const item = toItem(
        m,
        isAll ? "overall" : str(m.model_name) ?? `w${i}`,
        isAll ? "套餐总额" : str(m.model_name) ?? `窗口 ${i + 1}`,
        isAll ? "overall" : "window"
      );
      if (item) items.push(item);
    });
    return { items, raw: body };
  }

  // Primary form: `usage` (overall/plan window) + `limits[]` (each with a window).
  const usage = asObj(root.usage);
  if (usage) {
    const item = toItem(usage, "overall", "套餐总额", "overall");
    if (item) items.push(item);
  }
  const limits = Array.isArray(root.limits) ? root.limits : [];
  limits.forEach((raw, i) => {
    const l = asObj(raw);
    if (!l) return;
    const detail = asObj(l.detail) ?? l;
    const window = asObj(l.window);
    const item = toItem(detail, windowKey(window, i), windowLabel(window, i), "window", window);
    if (item) items.push(item);
  });
  return { items, raw: body };
}

/** Minimal response shape the sync loop needs (a subset of the Fetch `Response`). */
export type KimiResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
};
export type KimiFetch = (
  url: string,
  apiKey: string,
  signal: AbortSignal
) => Promise<KimiResponse>;

function defaultFetch(url: string, apiKey: string, signal: AbortSignal): Promise<KimiResponse> {
  return fetch(url, {
    signal,
    headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT },
  });
}

/** Actionable hint by status; NEVER echoes the key. */
function errorHint(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return "Kimi Code 认证失败(401/403):请用 Kimi Code 控制台的编程套餐 key(sk-kimi-…),不是开放平台 key(sk-…)";
    case 404:
      return "Kimi Code 用量接口未找到(404):确认 base 为 https://api.kimi.com/coding/v1 且 key 来自编程套餐";
    case 429:
      return "Kimi Code 请求过于频繁(429),稍后再试";
    default:
      return `Kimi Code 接口返回错误 ${status}`;
  }
}

export function createKimiProvider(fetchRaw: KimiFetch = defaultFetch): ProviderUsageSource {
  return {
    id: "kimi",
    label: "Kimi Code",
    async sync(config: ProviderSyncConfig): Promise<ProviderSnapshot> {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      try {
        let r = await fetchRaw(ENDPOINT, config.apiKey, ac.signal);
        // Only 404 falls back to the singular endpoint; 401 etc. surface as-is
        // (a bad token must not be retried as a "maybe wrong path").
        if (r.status === 404) r = await fetchRaw(FALLBACK, config.apiKey, ac.signal);
        if (!r.ok) throw new Error(errorHint(r.status));
        return parseKimiUsages(await r.json());
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
