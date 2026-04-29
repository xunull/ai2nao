import type Database from "better-sqlite3";
import { defaultMacAppRoots, isMacAppInventorySupported } from "./roots.js";
import { scanMacApps, type ScanMacAppsOptions } from "./scan.js";
import type { MacAppRecord } from "./plist.js";
import { finishInventorySyncRun, startInventorySyncRun } from "../../localInventory/syncRuns.js";
import { setInventorySyncStateValue } from "../../localInventory/state.js";
import type { SoftwareWarning, SyncCounts } from "../types.js";

export type SyncMacAppsOptions = ScanMacAppsOptions & {
  roots?: string[];
  now?: () => Date;
  platformSupported?: boolean;
};

export type SyncMacAppsResult = SyncCounts & {
  ok: boolean;
  status: "success" | "partial" | "failed";
  roots: string[];
  warnings: SoftwareWarning[];
  runId: number;
};

export async function syncMacApps(
  db: Database.Database,
  opts: SyncMacAppsOptions = {}
): Promise<SyncMacAppsResult> {
  const now = opts.now ?? (() => new Date());
  const roots = opts.roots?.length ? opts.roots : defaultMacAppRoots();
  const runId = startInventorySyncRun(db, "mac_apps", { roots }, now());

  const platformSupported = opts.platformSupported ?? isMacAppInventorySupported();
  if (!platformSupported) {
    return fail(db, runId, roots, "macOS app inventory is only supported on macOS", now);
  }
  if (roots.length === 0) {
    return fail(db, runId, roots, "No readable application roots found", now);
  }

  try {
    const scanned = await scanMacApps(roots, opts);
    const readableRoots = roots.filter(
      (r) => !scanned.warnings.some((w) => w.code === "root_unreadable" && w.path === r)
    );
    if (readableRoots.length === 0) {
      return fail(db, runId, roots, "No readable application roots found", now, scanned.warnings);
    }

    const counts = upsertMacApps(db, scanned.apps, readableRoots, now().toISOString());
    const status = scanned.warnings.length > 0 ? "partial" : "success";
    finishInventorySyncRun(db, runId, {
      status,
      ...counts,
      warningsCount: scanned.warnings.length,
      errorSummary: scanned.warnings.slice(0, 5).map((w) => w.message).join("\n") || null,
      metadata: { roots: scanned.roots },
      now: now(),
    });
    setInventorySyncStateValue(db, "mac_apps.last_sync_at", now().toISOString());
    setInventorySyncStateValue(
      db,
      "mac_apps.last_sync_error",
      status === "partial" ? scanned.warnings.slice(0, 5).map((w) => w.message).join("\n") : null
    );
    return { ok: true, status, roots: scanned.roots, warnings: scanned.warnings, runId, ...counts };
  } catch (e) {
    return fail(db, runId, roots, e instanceof Error ? e.message : String(e), now);
  }
}

function upsertMacApps(
  db: Database.Database,
  apps: MacAppRecord[],
  scannedRoots: string[],
  nowIso: string
): SyncCounts {
  const tx = db.transaction(() => {
    let inserted = 0;
    let updated = 0;
    const existing = db.prepare("SELECT id FROM mac_apps WHERE path = ?");
    const upsert = db.prepare(
      `INSERT INTO mac_apps (
        bundle_id, name, path, version, short_version, executable, bundle_name,
        bundle_display_name, minimum_system_version, category, source_root,
        first_seen_at, last_seen_at, missing_since, inserted_at, updated_at
      ) VALUES (
        @bundle_id, @name, @path, @version, @short_version, @executable, @bundle_name,
        @bundle_display_name, @minimum_system_version, @category, @source_root,
        @now, @now, NULL, @now, @now
      )
      ON CONFLICT(path) DO UPDATE SET
        bundle_id = excluded.bundle_id,
        name = excluded.name,
        version = excluded.version,
        short_version = excluded.short_version,
        executable = excluded.executable,
        bundle_name = excluded.bundle_name,
        bundle_display_name = excluded.bundle_display_name,
        minimum_system_version = excluded.minimum_system_version,
        category = excluded.category,
        source_root = excluded.source_root,
        last_seen_at = excluded.last_seen_at,
        missing_since = NULL,
        updated_at = excluded.updated_at`
    );
    for (const app of apps) {
      const wasExisting = existing.get(app.path) != null;
      upsert.run({ ...app, now: nowIso });
      if (wasExisting) updated++;
      else inserted++;
    }

    let markedMissing = 0;
    if (scannedRoots.length > 0) {
      const seen = new Set(apps.map((a) => a.path));
      const rows = db
        .prepare(
          `SELECT path FROM mac_apps
           WHERE missing_since IS NULL
             AND source_root IN (${scannedRoots.map(() => "?").join(",")})`
        )
        .all(...scannedRoots) as { path: string }[];
      const mark = db.prepare(
        "UPDATE mac_apps SET missing_since = ?, updated_at = ? WHERE path = ?"
      );
      for (const row of rows) {
        if (seen.has(row.path)) continue;
        markedMissing += mark.run(nowIso, nowIso, row.path).changes;
      }
    }
    return { inserted, updated, markedMissing };
  });
  return tx();
}

function fail(
  db: Database.Database,
  runId: number,
  roots: string[],
  message: string,
  now: () => Date,
  warnings: SoftwareWarning[] = []
): SyncMacAppsResult {
  finishInventorySyncRun(db, runId, {
    status: "failed",
    inserted: 0,
    updated: 0,
    markedMissing: 0,
    warningsCount: warnings.length,
    errorSummary: message,
    metadata: { roots },
    now: now(),
  });
  setInventorySyncStateValue(db, "mac_apps.last_sync_error", message);
  return {
    ok: false,
    status: "failed",
    roots,
    warnings,
    runId,
    inserted: 0,
    updated: 0,
    markedMissing: 0,
  };
}
