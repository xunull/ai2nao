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
  if (d == null) return `用量 ${i + 1}`;
  if (u.includes("MINUTE"))
    return d >= 60 && d % 60 === 0 ? `${d / 60} 小时用量` : `${d} 分钟用量`;
  if (u.includes("HOUR")) return `${d} 小时用量`;
  if (u.includes("DAY")) return `${d} 天用量`;
  if (u.includes("MONTH")) return `${d} 月用量`;
  return `${d} 秒用量`;
}

/** One quota block ({limit, remaining, resetTime}) → a snapshot item, or null. */
function toItem(
  data: Record<string, unknown>,
  key: string,
  label: string,
  kind: "weekly" | "window",
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

/** 已知会员等级 → 中文;未知(如付费档)回退去掉 LEVEL_ 前缀的原始枚举。 */
const KIMI_LEVEL_ZH: Record<string, string> = {
  LEVEL_TRIAL: "试用",
  LEVEL_FREE: "免费",
};

/**
 * 会员档位友好名。API 只给 `membership.level` 枚举(试用账号是 LEVEL_TRIAL)+
 * `subType`,**不含价格/计费周期**;付费档枚举需升级后才能看到真值,故未知档回退
 * 显原始枚举尾巴,不臆造。价格若要显示,只能由调用方另配「档位→¥」映射。
 */
export function kimiTierLabel(level: string | null, subType: string | null): string {
  if (level && KIMI_LEVEL_ZH[level]) return KIMI_LEVEL_ZH[level];
  if (level) return level.replace(/^LEVEL_/, "");
  return subType === "TYPE_PURCHASE" ? "已购买" : "—";
}

/** 把顶层 user.membership.level / subType / parallel.limit 收成一个 kind:"membership" 项。 */
function membershipItem(root: Record<string, unknown>): ProviderSnapshotItem | null {
  const user = asObj(root.user);
  const membership = user ? asObj(user.membership) : null;
  const level = membership ? str(membership.level) : null;
  const subType = str(root.subType);
  const parallel = asObj(root.parallel);
  const parallelLimit = parallel ? numLoose(parallel.limit) : null;
  if (level == null && subType == null && parallelLimit == null) return null;
  return {
    key: "membership",
    label: "当前档位",
    remainingPercent: null,
    resetAt: null,
    detail: { kind: "membership", level, subType, parallelLimit },
  };
}

/** Parse a Kimi Code /usages body into snapshot items (exported for tests). */
export function parseKimiUsages(body: unknown): ProviderSnapshot {
  const root = asObj(body);
  const items: ProviderSnapshotItem[] = [];
  if (!root) return { items, raw: body };

  // 档位/并发是套餐元信息(非配额窗口),用 kind:"membership" 标记,前端/卡片单独渲。
  const membership = membershipItem(root);
  const withMeta = (windows: ProviderSnapshotItem[]): ProviderSnapshot => ({
    items: membership ? [membership, ...windows] : windows,
    raw: body,
  });

  // Tolerated form: a flat `data[]` list (community-observed; model_name "all"
  // is the overall summary). This account returns the usage+limits form below.
  if (Array.isArray(root.data)) {
    root.data.forEach((raw, i) => {
      const m = asObj(raw);
      if (!m) return;
      const isAll = str(m.model_name) === "all";
      const item = toItem(
        m,
        isAll ? "weekly" : str(m.model_name) ?? `w${i}`,
        isAll ? "7 天用量" : str(m.model_name) ?? `用量 ${i + 1}`,
        isAll ? "weekly" : "window"
      );
      if (item) items.push(item);
    });
    return withMeta(items);
  }

  // Primary form: `usage` (the 7-day/weekly window — verified against Kimi's
  // member page: usage.resetTime lines up with the "7 天用量" bar, NOT a monthly
  // total) + `limits[]` (each a shorter window, e.g. 5h). The monthly "总使用量"
  // shown on the web member page is NOT in this endpoint (totalQuota stays {}).
  const usage = asObj(root.usage);
  if (usage) {
    const item = toItem(usage, "weekly", "7 天用量", "weekly");
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
  return withMeta(items);
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
      // sync() already rejects a keyless run for key-requiring sources; this
      // narrows `string | null` without an assertion.
      const apiKey = config.apiKey;
      if (!apiKey) throw new Error("未配置 Kimi Code API key");
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      try {
        let r = await fetchRaw(ENDPOINT, apiKey, ac.signal);
        // Only 404 falls back to the singular endpoint; 401 etc. surface as-is
        // (a bad token must not be retried as a "maybe wrong path").
        if (r.status === 404) r = await fetchRaw(FALLBACK, apiKey, ac.signal);
        if (!r.ok) throw new Error(errorHint(r.status));
        return parseKimiUsages(await r.json());
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
