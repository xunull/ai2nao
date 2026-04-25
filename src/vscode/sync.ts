import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import Database from "better-sqlite3";
import type DatabaseTypes from "better-sqlite3";
import { canonicalizePath } from "../path/canonical.js";
import { defaultVscodeStatePath, parseVscodeAppId } from "./paths.js";
import { parseRecentlyOpenedPathsList, VscodeRecentParseError } from "./recent.js";
import { copyVscodeStateSnapshot, removeVscodeSnapshot, VscodeSourceMissingError } from "./snapshot.js";
import { getOrCreateRemoteHashSalt } from "./state.js";
import type { ParsedVscodeRecentEntry, VscodeAppId, VscodeWarning } from "./types.js";

export type SyncVscodeRecentOptions = {
  app?: string;
  profile?: string;
  sourcePath?: string;
  now?: Date;
  existsPath?: (path: string) => boolean;
};

export type VscodeSyncResult = {
  ok: boolean;
  status: "success" | "partial" | "failed";
  app: VscodeAppId;
  profile: string;
  sourcePath: string | null;
  inserted: number;
  updated: number;
  markedMissing: number;
  totalEntries: number;
  warnings: VscodeWarning[];
};

const RECENT_KEY = "history.recentlyOpenedPathsList";

export function syncVscodeRecent(
  db: DatabaseTypes.Database,
  opts: SyncVscodeRecentOptions = {}
): VscodeSyncResult {
  const app = parseVscodeAppId(opts.app ?? "code");
  if (!app) throw new Error("invalid VS Code app");
  const profile = cleanProfile(opts.profile);
  const sourcePath = opts.sourcePath ?? defaultVscodeStatePath(app);
  const nowIso = (opts.now ?? new Date()).toISOString();
  const existsPath = opts.existsPath ?? existsSync;
  const base: Omit<VscodeSyncResult, "ok" | "status" | "inserted" | "updated" | "markedMissing" | "totalEntries" | "warnings"> = {
    app,
    profile,
    sourcePath,
  };
  if (!sourcePath) {
    return failed(base, [
      { code: "source_missing", message: "Current platform has no known VS Code state.vscdb path" },
    ]);
  }

  let snapshot: ReturnType<typeof copyVscodeStateSnapshot> | null = null;
  try {
    snapshot = copyVscodeStateSnapshot(sourcePath);
    const raw = readRecentlyOpenedValue(snapshot.dbPath);
    if (raw == null) {
      return {
        ...base,
        ok: true,
        status: "partial",
        inserted: 0,
        updated: 0,
        markedMissing: 0,
        totalEntries: 0,
        warnings: [{ code: "key_missing", message: `${RECENT_KEY} was not found in VS Code state` }],
      };
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return failed(base, [
        { code: "key_missing", message: `${RECENT_KEY} contained invalid JSON` },
      ]);
    }

    const shapeError = validateRecentListShape(decoded);
    if (shapeError) {
      return failed(base, [{ code: "key_missing", message: shapeError }]);
    }

    const salt = getOrCreateRemoteHashSalt(db, nowIso);
    const parsed = parseRecentlyOpenedPathsList(decoded, salt);
    const entries = parsed.entries.map((entry) => enrichEntry(entry, existsPath));
    const remoteCount = entries.filter((entry) => entry.remoteType != null).length;
    const warnings = [...parsed.warnings];
    if (remoteCount > 0) {
      warnings.push({
        code: "remote_redacted",
        message: "Remote VS Code URI authorities and paths were hashed before storage",
        context: { count: remoteCount },
      });
    }
    const counts = upsertEntries(db, app, profile, entries, nowIso);
    return {
      ...base,
      ok: true,
      status: warnings.length ? "partial" : "success",
      ...counts,
      totalEntries: entries.length,
      warnings,
    };
  } catch (e) {
    if (e instanceof VscodeSourceMissingError) {
      return failed(base, [{ code: "source_missing", message: e.message }]);
    }
    if (e instanceof VscodeRecentParseError) {
      return failed(base, [{ code: "key_missing", message: e.message }]);
    }
    return failed(base, [{ code: "key_missing", message: e instanceof Error ? e.message : String(e) }]);
  } finally {
    removeVscodeSnapshot(snapshot);
  }
}

function readRecentlyOpenedValue(snapshotPath: string): string | null {
  const source = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  try {
    const row = source
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get(RECENT_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  } finally {
    source.close();
  }
}

function validateRecentListShape(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "VS Code recent list has invalid top-level shape";
  }
  if (!Array.isArray((raw as { entries?: unknown }).entries)) {
    return "VS Code recent list is missing entries array";
  }
  return null;
}

function enrichEntry(
  entry: ParsedVscodeRecentEntry,
  existsPath: (path: string) => boolean
): ParsedVscodeRecentEntry & { existsOnDisk: number | null } {
  if (!entry.path) return { ...entry, existsOnDisk: null };
  const exists = existsPath(entry.path);
  const canonical = canonicalizePath(entry.path, { bestEffort: true }) ?? entry.path;
  const label = entry.label ?? basename(entry.kind === "file" ? dirname(canonical) : canonical);
  return {
    ...entry,
    path: canonical,
    label,
    existsOnDisk: exists ? 1 : 0,
  };
}

function upsertEntries(
  db: DatabaseTypes.Database,
  app: VscodeAppId,
  profile: string,
  entries: Array<ParsedVscodeRecentEntry & { existsOnDisk: number | null }>,
  nowIso: string
): { inserted: number; updated: number; markedMissing: number } {
  const before = new Set(
    (
      db
        .prepare("SELECT uri_redacted FROM vscode_recent_entries WHERE app = ? AND profile = ?")
        .all(app, profile) as Array<{ uri_redacted: string }>
    ).map((row) => row.uri_redacted)
  );
  const seen = new Set(entries.map((entry) => entry.uriRedacted));
  const tx = db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO vscode_recent_entries (
        app, profile, kind, recent_index, uri_redacted, path, label,
        remote_type, remote_authority_hash, remote_path_hash, exists_on_disk,
        first_seen_at, last_seen_at, missing_since, inserted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(app, profile, uri_redacted) DO UPDATE SET
        kind = excluded.kind,
        recent_index = excluded.recent_index,
        path = excluded.path,
        label = excluded.label,
        remote_type = excluded.remote_type,
        remote_authority_hash = excluded.remote_authority_hash,
        remote_path_hash = excluded.remote_path_hash,
        exists_on_disk = excluded.exists_on_disk,
        last_seen_at = excluded.last_seen_at,
        missing_since = NULL,
        updated_at = excluded.updated_at`
    );
    for (const entry of entries) {
      upsert.run(
        app,
        profile,
        entry.kind,
        entry.recentIndex,
        entry.uriRedacted,
        entry.path,
        entry.label,
        entry.remoteType,
        entry.remoteAuthorityHash,
        entry.remotePathHash,
        entry.existsOnDisk,
        nowIso,
        nowIso,
        nowIso,
        nowIso
      );
    }
    if (seen.size === 0) {
      db.prepare(
        `UPDATE vscode_recent_entries
         SET missing_since = COALESCE(missing_since, ?), updated_at = ?
         WHERE app = ? AND profile = ? AND missing_since IS NULL`
      ).run(nowIso, nowIso, app, profile);
    } else {
      const placeholders = [...seen].map(() => "?").join(", ");
      db.prepare(
        `UPDATE vscode_recent_entries
         SET missing_since = COALESCE(missing_since, ?), updated_at = ?
         WHERE app = ? AND profile = ? AND missing_since IS NULL
           AND uri_redacted NOT IN (${placeholders})`
      ).run(nowIso, nowIso, app, profile, ...seen);
    }
  });
  tx();
  const inserted = entries.filter((entry) => !before.has(entry.uriRedacted)).length;
  const updated = entries.length - inserted;
  const markedMissing = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM vscode_recent_entries
         WHERE app = ? AND profile = ? AND missing_since = ?`
      )
      .get(app, profile, nowIso) as { n: number }
  ).n;
  return { inserted, updated, markedMissing };
}

function failed(
  base: Omit<VscodeSyncResult, "ok" | "status" | "inserted" | "updated" | "markedMissing" | "totalEntries" | "warnings">,
  warnings: VscodeWarning[]
): VscodeSyncResult {
  return {
    ...base,
    ok: false,
    status: "failed",
    inserted: 0,
    updated: 0,
    markedMissing: 0,
    totalEntries: 0,
    warnings,
  };
}

function cleanProfile(raw: string | undefined): string {
  const t = (raw ?? "default").trim();
  return t || "default";
}
