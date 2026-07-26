import {
  normalizeResetToIso,
  readClaudeCredential,
  redactPii,
  remainingFromUsedPercent,
  windowKeyAndLabel,
  type ClaudeCredential,
} from "./localCredentials.js";
import type {
  ProviderSnapshot,
  ProviderSnapshotItem,
  ProviderUsageSource,
} from "./types.js";

/**
 * Claude subscription QUOTA snapshot — the 5-hour and 7-day windows you see in
 * Claude Code's `/usage` panel. This is the plan's remaining allowance, which is
 * a different thing from `src/claudeTokenUsage/` (token counts parsed out of
 * local transcripts).
 *
 * Endpoint is Claude Code's own, UNDOCUMENTED, first-party OAuth usage call:
 *   GET https://api.anthropic.com/api/oauth/usage
 * authenticated with the OAuth access token this machine already holds (see
 * localCredentials). An `ANTHROPIC_API_KEY` does NOT work here — the endpoint
 * wants the subscription's OAuth token, and API keys 401.
 *
 * Real response (verified 2026-07-26, a Max account):
 *   { five_hour: { utilization: 52.0, resets_at: "2026-07-26T06:30:00.069698+00:00" },
 *     seven_day: { utilization:  3.0, resets_at: "2026-08-02T03:00:00.069723+00:00" },
 *     limits: [ { kind:"session", percent:52, is_active:true, resets_at:"…" },
 *               { kind:"weekly_all", percent:3, is_active:false, resets_at:"…" },
 *               { kind:"weekly_scoped", percent:0, scope:{model:{display_name:"Fable"}} } ],
 *     extra_usage:{…}, spend:{…}, member_dashboard_available:false,
 *     seven_day_opus:null, tangelo:null, iguana_necktie:null, nimbus_quill:null, … }
 *
 * Parsing notes: `utilization` is USED percent (remainingPercent = 100 − used —
 * the opposite of Kimi's payload); `resets_at` is ISO with microseconds. The
 * null-valued codename fields (tangelo / iguana_necktie / nimbus_quill /
 * cinder_cove …) are internal and deliberately NOT parsed — they stay in raw.
 *
 * `extra_usage` / `spend` are purchased credits, not the subscription window,
 * and are excluded on purpose: mixing them into the same table would misread as
 * "quota left".
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const USER_AGENT = "claude-code/2.1.0";
const TIMEOUT_MS = 12_000;

/** Windows this provider surfaces, in display order. */
const WINDOWS: Array<{ field: string; minutes: number }> = [
  { field: "five_hour", minutes: 300 },
  { field: "seven_day", minutes: 10080 },
];

function asObj(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/** `utilization` is the documented field; `used_percentage` appears on older payloads. */
function usedPercentOf(w: Record<string, unknown>): number | null {
  const u = typeof w.utilization === "number" ? w.utilization : w.used_percentage;
  return typeof u === "number" && Number.isFinite(u) ? u : null;
}

/**
 * The scoped per-model limit (currently "Fable") shows in Claude's own panel but
 * has no top-level window field, so it is read out of `limits[]`. `is_active`
 * marks the currently-binding limit, NOT data validity — an inactive entry still
 * carries a real percent, so it must not be filtered on.
 */
function scopedModelItems(root: Record<string, unknown>): ProviderSnapshotItem[] {
  if (!Array.isArray(root.limits)) return [];
  const out: ProviderSnapshotItem[] = [];
  for (const raw of root.limits) {
    const l = asObj(raw);
    if (!l || l.kind !== "weekly_scoped") continue;
    const model = asObj(asObj(l.scope)?.model);
    const name = typeof model?.display_name === "string" ? model.display_name.trim() : "";
    const used = typeof l.percent === "number" && Number.isFinite(l.percent) ? l.percent : null;
    if (!name || used == null) continue;
    out.push({
      key: `7d-${name.toLowerCase()}`,
      label: `7 天用量 · ${name}`,
      remainingPercent: remainingFromUsedPercent(used),
      resetAt: normalizeResetToIso(l.resets_at),
      detail: {
        kind: "window",
        scope: "model",
        model: name,
        usedPercent: used,
        windowMinutes: 10080,
        isActive: l.is_active === true,
      },
    });
  }
  return out;
}

/** Parse an /api/oauth/usage body into snapshot items (exported for tests). */
export function parseClaudeOAuthUsage(body: unknown): ProviderSnapshot {
  const root = asObj(body);
  // raw goes to SQLite verbatim; redact defensively even though this payload
  // carries no PII today (the endpoint is undocumented and may grow fields).
  const raw = redactPii(body);
  if (!root) return { items: [], raw };

  const items: ProviderSnapshotItem[] = [];
  for (const { field, minutes } of WINDOWS) {
    const w = asObj(root[field]);
    if (!w) continue;
    const used = usedPercentOf(w);
    if (used == null) continue;
    const { key, label } = windowKeyAndLabel(minutes, items.length);
    items.push({
      key,
      label,
      remainingPercent: remainingFromUsedPercent(used),
      resetAt: normalizeResetToIso(w.resets_at),
      detail: { kind: "window", usedPercent: used, windowMinutes: minutes },
    });
  }
  items.push(...scopedModelItems(root));
  return { items, raw };
}

/** Minimal response shape the sync loop needs (a subset of the Fetch `Response`). */
export type ClaudeUsageResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};
export type ClaudeUsageFetch = (
  url: string,
  token: string,
  signal: AbortSignal
) => Promise<ClaudeUsageResponse>;

function defaultFetch(url: string, token: string, signal: AbortSignal): Promise<ClaudeUsageResponse> {
  return fetch(url, {
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_BETA_HEADER,
      // Matching Claude Code's own user-agent keeps us on the contract this
      // endpoint is actually served for.
      "User-Agent": USER_AGENT,
    },
  });
}

/** Actionable hint by status; NEVER echoes the token. */
function errorHint(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return "Claude 订阅凭据已失效(401/403):请在 Claude Code 里重新登录(ai2nao 只读取凭据,不会替你刷新)";
    case 429:
      return "Claude 用量接口请求过于频繁(429),稍后再试";
    default:
      return `Claude 用量接口返回错误 ${status}`;
  }
}

export function createClaudeSubscriptionProvider(deps?: {
  fetchUsage?: ClaudeUsageFetch;
  readCredential?: () => Promise<ClaudeCredential | null>;
}): ProviderUsageSource {
  const fetchUsage = deps?.fetchUsage ?? defaultFetch;
  const readCredential = deps?.readCredential ?? (() => readClaudeCredential());
  return {
    id: "claude",
    label: "Claude 订阅",
    // Reads this machine's Claude Code login; there is no key to paste.
    requiresApiKey: false,
    async sync(): Promise<ProviderSnapshot> {
      const cred = await readCredential();
      if (!cred) {
        throw new Error("未检测到 Claude Code 登录凭据:请先在 Claude Code 中登录");
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      try {
        const r = await fetchUsage(USAGE_URL, cred.token, ac.signal);
        if (!r.ok) throw new Error(errorHint(r.status));
        const snap = parseClaudeOAuthUsage(await r.json());
        return {
          items: snap.items.map((i) => ({
            ...i,
            detail: { ...i.detail, credentialOrigin: cred.origin },
          })),
          raw: snap.raw,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
