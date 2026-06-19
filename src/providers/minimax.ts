import type {
  ProviderSnapshot,
  ProviderSnapshotItem,
  ProviderSyncConfig,
  ProviderUsageSource,
} from "./types.js";

/**
 * MiniMax usage source. MiniMax has NO per-day/month usage API — only
 * `GET /v1/token_plan/remains`, which returns a CURRENT snapshot of remaining
 * quota per model group, for a 5-hour rolling window and a weekly window.
 *
 * Real response (verified 2026-06-19):
 *   { model_remains: [ {
 *       model_name, end_time(ms), current_interval_remaining_percent,
 *       weekly_end_time(ms), current_weekly_remaining_percent, ...
 *     } ], base_resp: { status_code, status_msg } }
 *
 * The interpretable signal is `current_interval_remaining_percent` (+ reset
 * time); `*_count` / `remains_time` are unreliable (often 0 / opaque), so we
 * surface the percent, not a fabricated cumulative. Parsing is defensive and
 * the raw response is always kept.
 */

const ENDPOINT = "https://www.minimaxi.com/v1/token_plan/remains";
const TIMEOUT_MS = 12_000;

function asObj(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
/** MiniMax timestamps are epoch ms; → ISO, or null. */
function msToIso(v: unknown): string | null {
  const n = num(v);
  return n != null && n > 0 ? new Date(n).toISOString() : null;
}

async function defaultFetchJson(
  url: string,
  apiKey: string,
  signal: AbortSignal
): Promise<unknown> {
  const r = await fetch(url, {
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export type MinimaxFetch = (
  url: string,
  apiKey: string,
  signal: AbortSignal
) => Promise<unknown>;

/** Parse a token_plan/remains body into snapshot items (exported for tests). */
export function parseMinimaxRemains(body: unknown): ProviderSnapshot {
  const root = asObj(body);
  const base = root ? asObj(root.base_resp) : null;
  // status_code != 0 → API-level error (e.g. invalid key); surface it.
  if (base && num(base.status_code) !== 0 && num(base.status_code) !== null) {
    throw new Error(`minimax: ${str(base.status_msg) ?? "error"} (${base.status_code})`);
  }
  const list = root && Array.isArray(root.model_remains) ? root.model_remains : [];
  const items: ProviderSnapshotItem[] = [];
  for (const raw of list) {
    const m = asObj(raw);
    if (!m) continue;
    const model = str(m.model_name) ?? "unknown";
    items.push({
      key: model,
      label: model,
      remainingPercent: num(m.current_interval_remaining_percent),
      resetAt: msToIso(m.end_time),
      detail: {
        windowStart: msToIso(m.start_time),
        weeklyRemainingPercent: num(m.current_weekly_remaining_percent),
        weeklyResetAt: msToIso(m.weekly_end_time),
        intervalStatus: num(m.current_interval_status),
        weeklyStatus: num(m.current_weekly_status),
      },
    });
  }
  return { items, raw: body };
}

export function createMinimaxProvider(fetchJson: MinimaxFetch = defaultFetchJson): ProviderUsageSource {
  return {
    id: "minimax",
    label: "MiniMax",
    async sync(config: ProviderSyncConfig): Promise<ProviderSnapshot> {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      try {
        const body = await fetchJson(ENDPOINT, config.apiKey, ac.signal);
        return parseMinimaxRemains(body);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
