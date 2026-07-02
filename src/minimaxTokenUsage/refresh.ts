import type Database from "better-sqlite3";
import {
  MINIMAX_NON_USAGE_METHODS,
  type MinimaxTokenEvent,
} from "./types.js";

/**
 * MiniMax billing-history refresh.
 *
 * Pulls a rolling window of `GET /account/amount` charge_records (Bearer key),
 * parses them into events, and idempotently upserts them by
 * PK(event_at, method, model, api_token_name). Because billing lags T+1~T+2 and
 * late hours can appear a day or two later, each refresh RE-PULLS a rolling
 * window (default 14 days ≫ the lag) and upserts — late arrivals backfill, and
 * a partial-page failure never wipes existing rows (upsert-only, in a txn).
 *
 * The API key is passed in by the caller (scheduler task reads it from
 * provider_config) so this module has no cross-module DB coupling. Errors never
 * contain the key (the transport helper's messages are key-free; guarded anyway).
 */

const ENDPOINT = "https://www.minimaxi.com/account/amount";
const TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;
/** Hard cap so a huge/looping history can't hang the scheduler (codex #3). */
const MAX_PAGES = 60;
/** Rolling re-pull window; ≫ the T+1~T+2 lag so late hours always backfill. */
export const DEFAULT_WINDOW_DAYS = 14;

export type MinimaxAmountFetch = (
  url: string,
  apiKey: string,
  signal: AbortSignal
) => Promise<unknown>;

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
      Accept: "application/json",
      Referer: "https://platform.minimaxi.com/",
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function asObj(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}
function intOf(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/**
 * Parse one charge_record. Returns null for records that are NOT token usage:
 * known account events (code_plan_purchase), 0-token rows, or records with no
 * usable timestamp. Malformed-but-usage records are still soft-parsed (missing
 * numeric fields default to 0) rather than dropping a whole page. `consume_token`
 * is intentionally NOT trusted here (input/output are authoritative); the
 * `consume_token == input + output` invariant is a TEST assertion only.
 */
export function parseChargeRecord(raw: unknown): MinimaxTokenEvent | null {
  const m = asObj(raw);
  if (!m) return null;
  const method = str(m.method) ?? "";
  if (MINIMAX_NON_USAGE_METHODS.has(method)) return null;
  const input = intOf(m.consume_input_token);
  const output = intOf(m.consume_output_token);
  if (input === 0 && output === 0) return null;
  const createdAtSec = intOf(m.created_at);
  if (createdAtSec <= 0) return null;
  return {
    event_at: new Date(createdAtSec * 1000).toISOString(),
    method,
    model: str(m.model) ?? "",
    api_token_name: str(m.api_token_name) ?? "",
    input_tokens: input,
    output_tokens: output,
    consume_cash: str(m.consume_cash),
    raw_json: JSON.stringify(raw),
  };
}

/** Validate the top-level body and return its raw charge_records array. */
function extractRecords(body: unknown): unknown[] {
  const root = asObj(body);
  // Non-JSON / HTML login page / unexpected shape → hard fail (surfaced as a
  // failed sync; existing rows are kept).
  if (!root) throw new Error("minimax: unexpected response shape (not an object)");
  const base = asObj(root.base_resp);
  if (base) {
    const code = base.status_code;
    if (typeof code === "number" && code !== 0) {
      throw new Error(`minimax: ${str(base.status_msg) ?? "error"} (${code})`);
    }
  }
  return Array.isArray(root.charge_records) ? root.charge_records : [];
}

/**
 * Page through /account/amount newest-first, collecting raw records until we
 * reach the window cutoff, a short page, or the page cap. Records are pre-sorted
 * newest-first, so once a page's oldest record predates the cutoff we can stop.
 */
async function fetchWindowRecords(
  fetchJson: MinimaxAmountFetch,
  apiKey: string,
  cutoffMs: number
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let records: unknown[];
    try {
      const url = `${ENDPOINT}?page=${page}&limit=${PAGE_SIZE}&aggregate=false`;
      records = extractRecords(await fetchJson(url, apiKey, ac.signal));
    } finally {
      clearTimeout(timer);
    }
    if (records.length === 0) break;
    out.push(...records);
    // Stop once this page's oldest record is older than the window.
    let oldestMs = Infinity;
    for (const r of records) {
      const sec = intOf(asObj(r)?.created_at);
      if (sec > 0) oldestMs = Math.min(oldestMs, sec * 1000);
    }
    if (oldestMs < cutoffMs) break;
    if (records.length < PAGE_SIZE) break;
  }
  return out;
}

function upsertEvents(db: Database.Database, events: MinimaxTokenEvent[]): void {
  const ins = db.prepare(
    `INSERT INTO minimax_token_usage_event
       (event_at, method, model, api_token_name, input_tokens, output_tokens, consume_cash, raw_json)
     VALUES (@event_at, @method, @model, @api_token_name, @input_tokens, @output_tokens, @consume_cash, @raw_json)
     ON CONFLICT(event_at, method, model, api_token_name) DO UPDATE SET
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       consume_cash = excluded.consume_cash,
       raw_json = excluded.raw_json`
  );
  const tx = db.transaction((rows: MinimaxTokenEvent[]) => {
    for (const e of rows) ins.run(e);
  });
  tx(events);
}

export type RefreshMinimaxResult = {
  status: "success" | "failed";
  eventCount: number;
  error?: string;
};

export type RefreshMinimaxArgs = {
  apiKey: string;
  /** Override clock (tests). */
  now?: Date;
  /** Rolling window in days (default 14). */
  windowDays?: number;
  /** Test seam: defaults to a real fetch. */
  fetchJson?: MinimaxAmountFetch;
};

/**
 * Refresh MiniMax token history. Fetches a rolling window, parses (dropping
 * non-usage/0-token/timeless records), and idempotently upserts within the
 * cutoff. Never throws — transport/parse failures return status:"failed" with a
 * key-free message so the caller can record it without crashing the scheduler.
 */
export async function refreshMinimaxTokenUsage(
  db: Database.Database,
  args: RefreshMinimaxArgs
): Promise<RefreshMinimaxResult> {
  const apiKey = args.apiKey?.trim();
  if (!apiKey) return { status: "failed", eventCount: 0, error: "未配置 API key" };
  const now = args.now ?? new Date();
  const windowDays = args.windowDays ?? DEFAULT_WINDOW_DAYS;
  const cutoffMs = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const fetchJson = args.fetchJson ?? defaultFetchJson;
  const cutoffIso = new Date(cutoffMs).toISOString();

  try {
    const raw = await fetchWindowRecords(fetchJson, apiKey, cutoffMs);
    const events: MinimaxTokenEvent[] = [];
    for (const r of raw) {
      const ev = parseChargeRecord(r);
      // Keep only events inside the rolling window (older pages may bleed in).
      if (ev && ev.event_at >= cutoffIso) events.push(ev);
    }
    upsertEvents(db, events);
    return { status: "success", eventCount: events.length };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split(apiKey).join("***");
    return { status: "failed", eventCount: 0, error: msg };
  }
}
