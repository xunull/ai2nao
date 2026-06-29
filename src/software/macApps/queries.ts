import type Database from "better-sqlite3";
import { getLatestInventorySyncRun } from "../../localInventory/syncRuns.js";
import { orderByClause, type SortCol } from "../../serve/orderBy.js";
import type { ListOptions, PageResult } from "../types.js";
import { defaultMacAppRoots, isMacAppInventorySupported } from "./roots.js";

/** Server-side sort allowlist for the Mac apps table (keys match column ids in the web UI). */
export const MAC_APP_SORT_ALLOWED: Record<string, SortCol> = {
  name: { expr: "name COLLATE NOCASE", defaultDir: "asc" },
  bundle: { expr: "bundle_id COLLATE NOCASE", defaultDir: "asc", nulls: "last" },
  path: { expr: "path COLLATE NOCASE", defaultDir: "asc" },
  seen: { expr: "last_seen_at", defaultDir: "desc" },
};

export type MacAppRow = {
  id: number;
  bundle_id: string | null;
  name: string;
  path: string;
  version: string | null;
  short_version: string | null;
  executable: string | null;
  source_root: string;
  last_seen_at: string;
  missing_since: string | null;
  updated_at: string;
};

export function getMacAppsStatus(db: Database.Database) {
  const counts = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN missing_since IS NULL THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN missing_since IS NOT NULL THEN 1 ELSE 0 END) AS missing
       FROM mac_apps`
    )
    .get() as { total: number; active: number | null; missing: number | null };
  return {
    platform: process.platform,
    supported: isMacAppInventorySupported(),
    defaultRoots: defaultMacAppRoots(),
    counts: {
      total: counts.total,
      active: counts.active ?? 0,
      missing: counts.missing ?? 0,
    },
    lastRun: getLatestInventorySyncRun(db, "mac_apps"),
  };
}

export function listMacApps(
  db: Database.Database,
  opts: ListOptions & { root?: string }
): PageResult<MacAppRow> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeMissing) where.push("missing_since IS NULL");
  if (opts.q) {
    where.push("(name LIKE ? OR bundle_id LIKE ? OR path LIKE ?)");
    const q = `%${opts.q}%`;
    params.push(q, q, q);
  }
  if (opts.root) {
    where.push("source_root = ?");
    params.push(opts.root);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // Present-before-removed stays a fixed leading partition; the user's column
  // sorts within it. Default (no sort) reproduces the old name-then-path order.
  const orderBy = orderByClause({
    sort: opts.sort,
    dir: opts.dir,
    allowed: MAC_APP_SORT_ALLOWED,
    prefix: "missing_since IS NOT NULL",
    defaultSortKey: "name",
    defaultDir: "asc",
    tiebreaker: "id ASC",
  });
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM mac_apps ${clause}`).get(...params) as {
      n: number;
    }
  ).n;
  const rows = db
    .prepare(
      `SELECT id, bundle_id, name, path, version, short_version, executable,
              source_root, last_seen_at, missing_since, updated_at
       FROM mac_apps
       ${clause}
       ${orderBy}
       LIMIT ? OFFSET ?`
    )
    .all(...params, opts.limit, opts.offset) as MacAppRow[];
  return { rows, total, limit: opts.limit, offset: opts.offset };
}
