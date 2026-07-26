import type Database from "better-sqlite3";
import {
  type CredentialName,
  deleteCredential,
  getCredentialRaw,
  setCredentialRaw,
} from "../settings/store.js";
import { listProviderSources } from "./registry.js";
import type { ProviderSnapshotItem } from "./types.js";

/**
 * Providers whose key has moved OUT of `provider_config.api_key` and into
 * config.db. The column stays (old rows still read from it as a fallback until
 * migration runs) but nothing writes to it any more: index.db is hundreds of MB
 * of scanned history that you can't exclude from a backup daemon, so a plaintext
 * key has no business living there.
 */
const CREDENTIAL_PROVIDERS: Record<string, CredentialName> = {
  minimax: "minimax",
  kimi: "kimi",
};

/** The key actually in effect: config.db first, then the legacy index.db column. */
export function providerApiKey(db: Database.Database, provider: string): string | null {
  const slot = CREDENTIAL_PROVIDERS[provider];
  if (slot) {
    const raw = getCredentialRaw(slot);
    if (raw) {
      try {
        const key = (JSON.parse(raw) as { apiKey?: unknown }).apiKey;
        if (typeof key === "string" && key.trim()) return key.trim();
      } catch {
        /* fall through to the legacy column */
      }
    }
  }
  const row = getProviderConfig(db, provider);
  const legacy = row?.api_key?.trim();
  return legacy ? legacy : null;
}

export type ProviderConfigRow = {
  provider: string;
  enabled: number;
  /** Separate opt-in for remote billing-history scraping (MiniMax /account/amount). */
  history_enabled: number;
  api_key: string | null;
  last_sync_at: string | null;
  last_status: string | null;
  last_error: string | null;
  updated_at: string;
};

export type ProviderUsageRow = {
  provider: string;
  item_key: string;
  label: string;
  remaining_percent: number | null;
  reset_at: string | null;
  detail_json: string | null;
  synced_at: string;
};

/** UI-facing view — NEVER includes the API key (only whether one is set). */
export type ProviderView = {
  id: string;
  label: string;
  enabled: boolean;
  /** Whether remote billing-history scraping is opted-in (separate from `enabled`). */
  historyEnabled: boolean;
  /** false → the source reads this machine's login; the UI shows no key field. */
  requiresApiKey: boolean;
  hasKey: boolean;
  lastSyncAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  items: Array<{
    key: string;
    label: string;
    remainingPercent: number | null;
    resetAt: string | null;
    detail: Record<string, unknown>;
    syncedAt: string;
  }>;
};

/** Seed a default (disabled, no key) row for every registered provider. */
export function ensureProviderConfigs(db: Database.Database, nowIso: string): void {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO provider_config (provider, enabled, updated_at)
     VALUES (?, 0, ?)`
  );
  const tx = db.transaction(() => {
    for (const s of listProviderSources()) ins.run(s.id, nowIso);
  });
  tx();
}

export function getProviderConfig(
  db: Database.Database,
  provider: string
): ProviderConfigRow | null {
  return (
    (db
      .prepare("SELECT * FROM provider_config WHERE provider = ?")
      .get(provider) as ProviderConfigRow | undefined) ?? null
  );
}

/** Update enable flag and/or API key. The key is only changed when provided
 *  (undefined leaves it; empty string clears it). */
export function setProviderConfig(
  db: Database.Database,
  provider: string,
  patch: { enabled?: boolean; historyEnabled?: boolean; apiKey?: string | undefined },
  nowIso: string
): void {
  const existing = getProviderConfig(db, provider);
  const enabled =
    patch.enabled == null ? (existing?.enabled ?? 0) : patch.enabled ? 1 : 0;
  const historyEnabled =
    patch.historyEnabled == null
      ? (existing?.history_enabled ?? 0)
      : patch.historyEnabled
        ? 1
        : 0;
  // The key goes to config.db, never back into this column. `undefined` means
  // "not part of this patch" (leave it alone); an empty string clears it.
  const slot = CREDENTIAL_PROVIDERS[provider];
  if (slot && patch.apiKey !== undefined) {
    const key = patch.apiKey.trim();
    if (key) setCredentialRaw(slot, JSON.stringify({ apiKey: key }));
    else deleteCredential(slot);
  }
  const apiKey = slot
    ? // Clear the legacy column only once this patch has actually stored the key
      // elsewhere. Nulling it on an unrelated patch (a mere `enabled` toggle)
      // would destroy a key that migration hasn't copied out yet.
      patch.apiKey !== undefined
      ? null
      : (existing?.api_key ?? null)
    : patch.apiKey === undefined
      ? (existing?.api_key ?? null)
      : patch.apiKey || null;
  db.prepare(
    `INSERT INTO provider_config (provider, enabled, history_enabled, api_key, updated_at)
     VALUES (@provider, @enabled, @history_enabled, @api_key, @updated_at)
     ON CONFLICT(provider) DO UPDATE SET
       enabled = excluded.enabled,
       history_enabled = excluded.history_enabled,
       api_key = excluded.api_key,
       updated_at = excluded.updated_at`
  ).run({
    provider,
    enabled,
    history_enabled: historyEnabled,
    api_key: apiKey,
    updated_at: nowIso,
  });
}

export function recordSyncResult(
  db: Database.Database,
  provider: string,
  status: "success" | "partial" | "failed",
  error: string | null,
  nowIso: string
): void {
  db.prepare(
    `UPDATE provider_config
     SET last_sync_at = ?, last_status = ?, last_error = ?, updated_at = ?
     WHERE provider = ?`
  ).run(nowIso, status, error, nowIso, provider);
}

/** Replace all usage items for one provider (delete-then-insert). */
export function replaceProviderUsage(
  db: Database.Database,
  provider: string,
  items: ProviderSnapshotItem[],
  nowIso: string
): void {
  const del = db.prepare("DELETE FROM provider_usage WHERE provider = ?");
  const ins = db.prepare(
    `INSERT INTO provider_usage
       (provider, item_key, label, remaining_percent, reset_at, detail_json, synced_at)
     VALUES (@provider, @item_key, @label, @remaining_percent, @reset_at, @detail_json, @synced_at)`
  );
  const tx = db.transaction(() => {
    del.run(provider);
    for (const it of items) {
      ins.run({
        provider,
        item_key: it.key,
        label: it.label,
        remaining_percent: it.remainingPercent,
        reset_at: it.resetAt,
        detail_json: JSON.stringify(it.detail ?? {}),
        synced_at: nowIso,
      });
    }
  });
  tx();
}

/**
 * UI list: every registered provider, its config (key MASKED → hasKey), and its
 * latest usage items. Never leaks the API key.
 */
export function listProviders(db: Database.Database): ProviderView[] {
  const configs = new Map(
    (db.prepare("SELECT * FROM provider_config").all() as ProviderConfigRow[]).map(
      (r) => [r.provider, r]
    )
  );
  const usage = db.prepare("SELECT * FROM provider_usage").all() as ProviderUsageRow[];
  const usageByProvider = new Map<string, ProviderUsageRow[]>();
  for (const u of usage) {
    const arr = usageByProvider.get(u.provider) ?? [];
    arr.push(u);
    usageByProvider.set(u.provider, arr);
  }
  return listProviderSources().map((s) => {
    const cfg = configs.get(s.id);
    return {
      id: s.id,
      label: s.label,
      enabled: !!cfg?.enabled,
      historyEnabled: !!cfg?.history_enabled,
      requiresApiKey: s.requiresApiKey !== false,
      hasKey: providerApiKey(db, s.id) !== null,
      lastSyncAt: cfg?.last_sync_at ?? null,
      lastStatus: cfg?.last_status ?? null,
      lastError: cfg?.last_error ?? null,
      items: (usageByProvider.get(s.id) ?? []).map((u) => ({
        key: u.item_key,
        label: u.label,
        remainingPercent: u.remaining_percent,
        resetAt: u.reset_at,
        detail: u.detail_json ? (JSON.parse(u.detail_json) as Record<string, unknown>) : {},
        syncedAt: u.synced_at,
      })),
    };
  });
}
