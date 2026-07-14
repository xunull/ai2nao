import type Database from "better-sqlite3";
import { getProviderSource, listProviderSources } from "./registry.js";
import type { ProviderUsageSource } from "./types.js";
import {
  ensureProviderConfigs,
  getProviderConfig,
  providerApiKey,
  recordSyncResult,
  replaceProviderUsage,
} from "./store.js";

export type SyncProviderResult = {
  provider: string;
  status: "success" | "partial" | "failed" | "skipped";
  itemCount: number;
  error?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Sync one provider. Skips when disabled. Fails cleanly (no crash) when no key
 * is configured or the API errors. The error message NEVER contains the key.
 */
export async function syncProvider(
  db: Database.Database,
  providerId: string,
  /** Test seam: defaults to the registered source. */
  source: ProviderUsageSource | null = getProviderSource(providerId)
): Promise<SyncProviderResult> {
  if (!source) return { provider: providerId, status: "skipped", itemCount: 0, error: "unknown provider" };

  const cfg = getProviderConfig(db, providerId);
  if (!cfg?.enabled) return { provider: providerId, status: "skipped", itemCount: 0 };
  const apiKey = providerApiKey(db, providerId);
  if (!apiKey) {
    const at = nowIso();
    recordSyncResult(db, providerId, "failed", "未配置 API key", at);
    return { provider: providerId, status: "failed", itemCount: 0, error: "未配置 API key" };
  }

  const at = nowIso();
  try {
    const snapshot = await source.sync({ apiKey });
    replaceProviderUsage(db, providerId, snapshot.items, at);
    // partial: fetched OK but parsed no items (shape drift) — raw is kept.
    const status = snapshot.items.length > 0 ? "success" : "partial";
    recordSyncResult(db, providerId, status, status === "partial" ? "无可解析项" : null, at);
    return { provider: providerId, status, itemCount: snapshot.items.length };
  } catch (e) {
    // Never include the key. Source errors are already key-free, but guard anyway.
    const msg = (e instanceof Error ? e.message : String(e)).replace(apiKey, "***");
    recordSyncResult(db, providerId, "failed", msg, at);
    return { provider: providerId, status: "failed", itemCount: 0, error: msg };
  }
}

export type SyncAllResult = {
  status: "success" | "partial" | "failed" | "skipped";
  results: SyncProviderResult[];
};

/** Sync every ENABLED provider; one failure never aborts the others. */
export async function syncEnabledProviders(db: Database.Database): Promise<SyncAllResult> {
  ensureProviderConfigs(db, nowIso());
  const results: SyncProviderResult[] = [];
  for (const s of listProviderSources()) {
    results.push(await syncProvider(db, s.id));
  }
  const ran = results.filter((r) => r.status !== "skipped");
  let status: SyncAllResult["status"];
  if (ran.length === 0) status = "skipped";
  else if (ran.every((r) => r.status === "success")) status = "success";
  else if (ran.every((r) => r.status === "failed")) status = "failed";
  else status = "partial";
  return { status, results };
}
