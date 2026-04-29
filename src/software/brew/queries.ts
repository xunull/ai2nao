import type Database from "better-sqlite3";
import { getLatestInventorySyncRun } from "../../localInventory/syncRuns.js";
import { getInventorySyncStateValue } from "../../localInventory/state.js";
import type { ListOptions, PageResult } from "../types.js";
import type { BrewPackageKind } from "./parse.js";
import { findBrewExecutable } from "./executable.js";

export type BrewPackageRow = {
  id: number;
  kind: BrewPackageKind;
  name: string;
  full_name: string | null;
  installed_version: string | null;
  current_version: string | null;
  desc: string | null;
  homepage: string | null;
  tap: string | null;
  installed_as_dependency: number | null;
  installed_on_request: number | null;
  outdated: number;
  last_seen_at: string;
  missing_since: string | null;
  updated_at: string;
};

export function getBrewStatus(db: Database.Database) {
  const detectedPath = findBrewExecutable();
  const counts = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN kind = 'formula' AND missing_since IS NULL THEN 1 ELSE 0 END) AS formulae,
        SUM(CASE WHEN kind = 'cask' AND missing_since IS NULL THEN 1 ELSE 0 END) AS casks,
        SUM(CASE WHEN missing_since IS NOT NULL THEN 1 ELSE 0 END) AS missing
       FROM brew_packages`
    )
    .get() as {
      total: number;
      formulae: number | null;
      casks: number | null;
      missing: number | null;
    };
  return {
    platform: process.platform,
    detected: detectedPath != null,
    brewPath: detectedPath ?? getInventorySyncStateValue(db, "brew.executable_path"),
    counts: {
      total: counts.total,
      formulae: counts.formulae ?? 0,
      casks: counts.casks ?? 0,
      missing: counts.missing ?? 0,
    },
    lastRun: getLatestInventorySyncRun(db, "brew"),
  };
}

export function listBrewPackages(
  db: Database.Database,
  opts: ListOptions & { kind?: BrewPackageKind }
): PageResult<BrewPackageRow> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeMissing) where.push("missing_since IS NULL");
  if (opts.kind) {
    where.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts.q) {
    where.push("(name LIKE ? OR full_name LIKE ? OR desc LIKE ? OR tap LIKE ?)");
    const q = `%${opts.q}%`;
    params.push(q, q, q, q);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM brew_packages ${clause}`).get(...params) as {
      n: number;
    }
  ).n;
  const rows = db
    .prepare(
      `SELECT id, kind, name, full_name, installed_version, current_version,
              desc, homepage, tap, installed_as_dependency, installed_on_request,
              outdated, last_seen_at, missing_since, updated_at
       FROM brew_packages
       ${clause}
       ORDER BY missing_since IS NOT NULL, kind, name COLLATE NOCASE
       LIMIT ? OFFSET ?`
    )
    .all(...params, opts.limit, opts.offset) as BrewPackageRow[];
  return { rows, total, limit: opts.limit, offset: opts.offset };
}
