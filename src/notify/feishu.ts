import { createHmac } from "node:crypto";

/**
 * Feishu (Lark) custom-bot webhook sender.
 *
 * Two traps this file exists to get right:
 *
 * 1. SIGNING. HMAC-SHA256 where the **key** is `${timestamp}\n${secret}` and the
 *    **message is the empty string**, base64-encoded. Everyone writes it the other
 *    way round (secret as key, timestamp as message) the first time. `timestamp`
 *    is seconds and must be within ~1h of Feishu's clock.
 *
 * 2. FAILURES COME BACK AS HTTP 200. A bad signature returns
 *    `200 {"code":19021,"msg":"sign match fail"}`. Checking `res.ok` alone would
 *    record every misconfigured push as "sent". Success is `res.ok && code === 0`.
 */
export type FeishuPostResult = { ok: true } | { ok: false; error: string };

/** Injectable for tests (house pattern: src/cost/modelsDevSync.ts). */
export type FetchJson = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const DEFAULT_TIMEOUT_MS = 10_000;

/** key = `${timestamp}\n${secret}`, message = "" — not the other way round. */
export function feishuSign(timestampSec: string, secret: string): string {
  return createHmac("sha256", `${timestampSec}\n${secret}`).update("").digest("base64");
}

export async function postFeishuCard(args: {
  webhookUrl: string;
  /** Feishu interactive-card payload (the `card` field). */
  card: unknown;
  secret?: string;
  now?: () => Date;
  fetchJson?: FetchJson;
  timeoutMs?: number;
}): Promise<FeishuPostResult> {
  const now = args.now ? args.now() : new Date();
  const timestamp = String(Math.floor(now.getTime() / 1000));

  const body: Record<string, unknown> = {
    msg_type: "interactive",
    card: args.card,
  };
  if (args.secret) {
    body.timestamp = timestamp;
    body.sign = feishuSign(timestamp, args.secret);
  }

  const doFetch: FetchJson =
    args.fetchJson ??
    ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchJson>);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(args.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    // HTTP 200 does NOT mean success — check the envelope.
    const payload = (await res.json().catch(() => null)) as
      | { code?: number; msg?: string; StatusCode?: number; StatusMessage?: string }
      | null;
    if (!payload) return { ok: false, error: "empty response body" };
    const code = payload.code ?? payload.StatusCode ?? 0;
    if (code !== 0) {
      const msg = payload.msg ?? payload.StatusMessage ?? "unknown";
      return { ok: false, error: `feishu code=${code}: ${msg}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
