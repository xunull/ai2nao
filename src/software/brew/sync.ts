import type Database from "better-sqlite3";
import {
  CommandFailedError,
  runBoundedCommand,
  type BoundedCommandResult,
} from "../command.js";
import { finishSoftwareSyncRun, startSoftwareSyncRun } from "../syncRuns.js";
import { setSoftwareSyncStateValue } from "../state.js";
import type { SoftwareWarning, SyncCounts } from "../types.js";
import { findBrewExecutable, validateCliBrewPath } from "./executable.js";
import {
  parseBrewInfoJson,
  parseBrewListOutput,
  type BrewPackageKind,
  type BrewPackageRecord,
} from "./parse.js";

export type BrewCommandRunner = (
  file: string,
  args: string[]
) => Promise<BoundedCommandResult>;

export type SyncBrewOptions = {
  brewPath?: string;
  allowCustomBrewPath?: boolean;
  commandRunner?: BrewCommandRunner;
  now?: () => Date;
};

export type SyncBrewResult = SyncCounts & {
  ok: boolean;
  status: "success" | "partial" | "failed";
  brewPath: string | null;
  warnings: SoftwareWarning[];
  runId: number;
};

export async function syncBrewPackages(
  db: Database.Database,
  opts: SyncBrewOptions = {}
): Promise<SyncBrewResult> {
  const now = opts.now ?? (() => new Date());
  let brewPath: string | null = null;
  try {
    brewPath =
      opts.brewPath && opts.allowCustomBrewPath
        ? validateCliBrewPath(opts.brewPath)
        : findBrewExecutable();
  } catch (e) {
    brewPath = null;
  }
  const runId = startSoftwareSyncRun(db, "brew", { brewPath }, now());
  if (!brewPath) {
    return fail(db, runId, null, "Homebrew executable not found", now);
  }

  const commandRunner =
    opts.commandRunner ??
    ((file: string, args: string[]) =>
      runBoundedCommand(file, args, { timeoutMs: 30_000, maxBuffer: 10 * 1024 * 1024 }));

  try {
    const loaded = await loadBrewPackages(brewPath, commandRunner);
    const counts = upsertBrewPackages(db, loaded.packages, loaded.completedKinds, now().toISOString());
    const status = loaded.warnings.length > 0 ? "partial" : "success";
    finishSoftwareSyncRun(db, runId, {
      status,
      ...counts,
      warningsCount: loaded.warnings.length,
      errorSummary: loaded.warnings.slice(0, 5).map((w) => w.message).join("\n") || null,
      metadata: { brewPath, fallback: loaded.fallback },
      now: now(),
    });
    setSoftwareSyncStateValue(db, "brew.last_sync_at", now().toISOString());
    setSoftwareSyncStateValue(db, "brew.executable_path", brewPath);
    setSoftwareSyncStateValue(
      db,
      "brew.last_sync_error",
      status === "partial" ? loaded.warnings.slice(0, 5).map((w) => w.message).join("\n") : null
    );
    return { ok: true, status, brewPath, warnings: loaded.warnings, runId, ...counts };
  } catch (e) {
    return fail(db, runId, brewPath, e instanceof Error ? e.message : String(e), now);
  }
}

async function loadBrewPackages(
  brewPath: string,
  commandRunner: BrewCommandRunner
): Promise<{
  packages: BrewPackageRecord[];
  completedKinds: BrewPackageKind[];
  warnings: SoftwareWarning[];
  fallback: boolean;
}> {
  try {
    const info = await commandRunner(brewPath, ["info", "--json=v2", "--installed"]);
    return {
      packages: parseBrewInfoJson(info.stdout),
      completedKinds: ["formula", "cask"],
      warnings: [],
      fallback: false,
    };
  } catch (e) {
    const warnings: SoftwareWarning[] = [
      {
        code: "brew_info_failed",
        message: e instanceof Error ? e.message : String(e),
      },
    ];
    const packages: BrewPackageRecord[] = [];
    const completedKinds: BrewPackageKind[] = [];
    for (const kind of ["formula", "cask"] as BrewPackageKind[]) {
      try {
        const out = await commandRunner(brewPath, ["list", `--${kind}`]);
        packages.push(...parseBrewListOutput(out.stdout, kind));
        completedKinds.push(kind);
      } catch (listErr) {
        if (listErr instanceof CommandFailedError) {
          warnings.push({ code: `brew_list_${kind}_failed`, message: listErr.message });
          continue;
        }
        warnings.push({
          code: `brew_list_${kind}_failed`,
          message: listErr instanceof Error ? listErr.message : String(listErr),
        });
      }
    }
    if (completedKinds.length === 0) {
      throw new Error(warnings.map((w) => w.message).join("\n"));
    }
    return { packages, completedKinds, warnings, fallback: true };
  }
}

function upsertBrewPackages(
  db: Database.Database,
  packages: BrewPackageRecord[],
  completedKinds: BrewPackageKind[],
  nowIso: string
): SyncCounts {
  const tx = db.transaction(() => {
    let inserted = 0;
    let updated = 0;
    const existing = db.prepare("SELECT id FROM brew_packages WHERE kind = ? AND name = ?");
    const upsert = db.prepare(
      `INSERT INTO brew_packages (
        kind, name, full_name, installed_version, current_version, desc, homepage, tap,
        installed_as_dependency, installed_on_request, outdated, caveats, aliases_json,
        dependencies_json, raw_json, first_seen_at, last_seen_at, missing_since,
        inserted_at, updated_at
      ) VALUES (
        @kind, @name, @full_name, @installed_version, @current_version, @desc, @homepage, @tap,
        @installed_as_dependency, @installed_on_request, @outdated, @caveats, @aliases_json,
        @dependencies_json, @raw_json, @now, @now, NULL, @now, @now
      )
      ON CONFLICT(kind, name) DO UPDATE SET
        full_name = excluded.full_name,
        installed_version = excluded.installed_version,
        current_version = excluded.current_version,
        desc = excluded.desc,
        homepage = excluded.homepage,
        tap = excluded.tap,
        installed_as_dependency = excluded.installed_as_dependency,
        installed_on_request = excluded.installed_on_request,
        outdated = excluded.outdated,
        caveats = excluded.caveats,
        aliases_json = excluded.aliases_json,
        dependencies_json = excluded.dependencies_json,
        raw_json = excluded.raw_json,
        last_seen_at = excluded.last_seen_at,
        missing_since = NULL,
        updated_at = excluded.updated_at`
    );
    for (const pkg of packages) {
      const wasExisting = existing.get(pkg.kind, pkg.name) != null;
      upsert.run({ ...pkg, now: nowIso });
      if (wasExisting) updated++;
      else inserted++;
    }

    let markedMissing = 0;
    const seenByKind = new Map<BrewPackageKind, Set<string>>();
    for (const kind of completedKinds) seenByKind.set(kind, new Set());
    for (const pkg of packages) seenByKind.get(pkg.kind)?.add(pkg.name);
    const rows = db
      .prepare("SELECT kind, name FROM brew_packages WHERE missing_since IS NULL")
      .all() as { kind: BrewPackageKind; name: string }[];
    const mark = db.prepare(
      "UPDATE brew_packages SET missing_since = ?, updated_at = ? WHERE kind = ? AND name = ?"
    );
    for (const row of rows) {
      const seen = seenByKind.get(row.kind);
      if (!seen || seen.has(row.name)) continue;
      markedMissing += mark.run(nowIso, nowIso, row.kind, row.name).changes;
    }
    return { inserted, updated, markedMissing };
  });
  return tx();
}

function fail(
  db: Database.Database,
  runId: number,
  brewPath: string | null,
  message: string,
  now: () => Date
): SyncBrewResult {
  finishSoftwareSyncRun(db, runId, {
    status: "failed",
    inserted: 0,
    updated: 0,
    markedMissing: 0,
    warningsCount: 0,
    errorSummary: message,
    metadata: { brewPath },
    now: now(),
  });
  setSoftwareSyncStateValue(db, "brew.last_sync_error", message);
  return {
    ok: false,
    status: "failed",
    brewPath,
    warnings: [],
    runId,
    inserted: 0,
    updated: 0,
    markedMissing: 0,
  };
}
