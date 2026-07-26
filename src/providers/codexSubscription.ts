import {
  normalizeResetToIso,
  readCodexCredential,
  redactPii,
  remainingFromUsedPercent,
  windowKeyAndLabel,
  type CodexCredential,
} from "./localCredentials.js";
import type {
  ProviderSnapshot,
  ProviderSnapshotItem,
  ProviderUsageSource,
} from "./types.js";

/**
 * Codex subscription QUOTA snapshot — the rate-limit windows Codex shows for
 * your ChatGPT plan. Companion to the Claude provider; same shape, different
 * back end.
 *
 * Endpoint is the ChatGPT web back end that Codex Desktop itself calls:
 *   GET https://chatgpt.com/backend-api/wham/usage
 * authenticated with the access token in `$CODEX_HOME/auth.json`. Note this is a
 * PRODUCT back end, not a published API — a grey-er surface than Anthropic's
 * OAuth usage endpoint, and likelier to change shape. Parsing stays defensive
 * and the raw body is kept.
 *
 * Real response (verified 2026-07-26, a Plus account; PII elided):
 *   { user_id:"…", account_id:"…", email:"…",          ← redacted before storage
 *     plan_type: "plus",
 *     rate_limit: { allowed:true, limit_reached:false,
 *       primary_window:   { used_percent:0, limit_window_seconds:604800,
 *                           reset_after_seconds:604800, reset_at:1785645160 },
 *       secondary_window: null },
 *     code_review_rate_limit:{…}, additional_rate_limits:{…},
 *     credits:{…}, spend_control:{…}, rate_limit_reset_credits:{…} }
 *
 * Three things this parser refuses to assume:
 *  1. `primary_window` is NOT necessarily the 5-hour window. On the verified
 *     account it is 604800s = 7 days and `secondary_window` is null. Window
 *     length is always derived from `limit_window_seconds`, never from which
 *     field the payload happened to land in.
 *  2. A null window produces NO row. An empty bar reads as "0% left".
 *  3. `used_percent` is USED; `remainingPercent` is REMAINING.
 *
 * `credits` / `spend_control` are purchased credits, not the plan window, and
 * are excluded on purpose.
 */

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USER_AGENT = "codex-cli";
const OPENAI_BETA = "codex-1";
const ORIGINATOR = "Codex Desktop";
const TIMEOUT_MS = 12_000;

function asObj(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** One rate_limit window → a snapshot item, or null when the window is absent. */
function toWindowItem(
  raw: unknown,
  index: number,
  planType: string | null
): ProviderSnapshotItem | null {
  const w = asObj(raw);
  if (!w) return null;
  const used = num(w.used_percent);
  if (used == null) return null;
  const seconds = num(w.limit_window_seconds);
  const minutes = seconds != null && seconds > 0 ? seconds / 60 : null;
  const { key, label } = windowKeyAndLabel(minutes, index);
  return {
    key,
    label,
    remainingPercent: remainingFromUsedPercent(used),
    // reset_at is epoch SECONDS here (Claude sends an ISO string).
    resetAt: normalizeResetToIso(w.reset_at) ?? resetFromRelative(w.reset_after_seconds),
    detail: {
      kind: "window",
      usedPercent: used,
      windowMinutes: minutes == null ? null : Math.round(minutes),
      planType,
    },
  };
}

/** Fallback when only a relative countdown is present. */
function resetFromRelative(v: unknown): string | null {
  const secs = num(v);
  if (secs == null || secs <= 0) return null;
  return new Date(Date.now() + secs * 1000).toISOString();
}

/** Parse a /wham/usage body into snapshot items (exported for tests). */
export function parseCodexWhamUsage(body: unknown): ProviderSnapshot {
  const root = asObj(body);
  // MUST redact before this reaches storage: the payload carries email/user_id/
  // account_id at the top level and raw is persisted verbatim.
  const raw = redactPii(body);
  if (!root) return { items: [], raw };

  const planType = typeof root.plan_type === "string" && root.plan_type.trim() ? root.plan_type.trim() : null;
  const rateLimit = asObj(root.rate_limit);
  const items: ProviderSnapshotItem[] = [];
  for (const field of ["primary_window", "secondary_window"]) {
    const item = toWindowItem(rateLimit?.[field], items.length, planType);
    if (item) items.push(item);
  }

  if (planType) {
    items.unshift({
      key: "plan",
      label: "当前档位",
      remainingPercent: null,
      resetAt: null,
      detail: { kind: "membership", planType, limitReached: rateLimit?.limit_reached === true },
    });
  }
  return { items, raw };
}

/** Minimal response shape the sync loop needs (a subset of the Fetch `Response`). */
export type CodexUsageResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};
export type CodexUsageFetch = (
  url: string,
  cred: CodexCredential,
  signal: AbortSignal
) => Promise<CodexUsageResponse>;

function defaultFetch(url: string, cred: CodexCredential, signal: AbortSignal): Promise<CodexUsageResponse> {
  return fetch(url, {
    signal,
    headers: {
      Authorization: `Bearer ${cred.accessToken}`,
      "User-Agent": USER_AGENT,
      "OpenAI-Beta": OPENAI_BETA,
      originator: ORIGINATOR,
      ...(cred.accountId ? { "ChatGPT-Account-Id": cred.accountId } : {}),
    },
  });
}

/** Actionable hint by status; NEVER echoes the token. */
function errorHint(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return "Codex 订阅凭据已失效(401/403):请重新执行 codex login(ai2nao 只读取凭据,不会替你刷新)";
    case 429:
      return "Codex 用量接口请求过于频繁(429),稍后再试";
    default:
      return `Codex 用量接口返回错误 ${status}`;
  }
}

export function createCodexSubscriptionProvider(deps?: {
  fetchUsage?: CodexUsageFetch;
  readCredential?: () => Promise<CodexCredential | null>;
}): ProviderUsageSource {
  const fetchUsage = deps?.fetchUsage ?? defaultFetch;
  const readCredential = deps?.readCredential ?? (() => readCodexCredential());
  return {
    id: "codex",
    label: "Codex 订阅",
    // Reads ~/.codex/auth.json; there is no key to paste.
    requiresApiKey: false,
    async sync(): Promise<ProviderSnapshot> {
      const cred = await readCredential();
      if (!cred) {
        throw new Error("未检测到 Codex 登录凭据(~/.codex/auth.json):请先执行 codex login");
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      try {
        const r = await fetchUsage(USAGE_URL, cred, ac.signal);
        if (!r.ok) throw new Error(errorHint(r.status));
        return parseCodexWhamUsage(await r.json());
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
