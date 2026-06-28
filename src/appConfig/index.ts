/**
 * App-level config (settings page) — NON-secret preferences only. Secrets live in
 * their 0600 files (e.g. GitHub token via src/github/config.ts), never here.
 *
 * Accessors are KEY-SPECIFIC and runtime-validated, NOT a generic getConfig<T>:
 * `JSON.parse() as T` gives no runtime guarantee, so a corrupt/hand-edited row
 * could smuggle `scan.roots: "oops"` into business logic. Each key gets its own
 * validating accessor; malformed/wrong-shape rows resolve to a safe default.
 */
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type Database from "better-sqlite3";
import { canonicalizePath } from "../path/canonical.js";

const KEY_SCAN_ROOTS = "scan.roots";
const MAX_ROOTS = 100;
const MAX_PATH_LEN = 4096;

const KEY_SCAN_MAX_DEPTH = "scan.maxDepth";
/** Default depth brake for repo discovery (levels below a scan root). */
export const DEFAULT_SCAN_MAX_DEPTH = 8;
const MAX_SCAN_DEPTH = 64;

/** Read + JSON.parse a config row; undefined when absent or unparseable. */
function readRaw(db: Database.Database, key: string): unknown {
  const row = db.prepare("SELECT value FROM app_config WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    // json_valid CHECK should prevent this, but stay defensive.
    console.warn(`app_config: unparseable value for ${key}; using default`);
    return undefined;
  }
}

function writeRaw(db: Database.Database, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), new Date().toISOString());
}

function deleteKey(db: Database.Database, key: string): void {
  db.prepare("DELETE FROM app_config WHERE key = ?").run(key);
}

/**
 * Default scan roots. Returns [] for unconfigured OR any wrong-shape stored value
 * (corruption-tolerant). Stored values are already canonical (validated on write),
 * but we still shape-check to never leak a bad value into the scanner.
 */
export function getScanRoots(db: Database.Database): string[] {
  const raw = readRaw(db, KEY_SCAN_ROOTS);
  if (!Array.isArray(raw) || !raw.every((r) => typeof r === "string")) {
    if (raw !== undefined) console.warn("app_config: scan.roots wrong shape; using []");
    return [];
  }
  return raw as string[];
}

/**
 * Validate + store scan roots. Each root must be an absolute, existing directory;
 * paths are canonicalized (symlinks resolved) and deduped. An empty array DELETES
 * the key (unconfigured), so an explicit `[]` never carries special meaning.
 * Throws (caller -> 400) with per-root reasons on any invalid input.
 *
 * NOTE: validation here is UX, not a security boundary — the scanner MUST re-check
 * each root at scan time (a stored dir can be deleted/swapped later).
 */
export function setScanRoots(db: Database.Database, roots: string[]): string[] {
  if (!Array.isArray(roots)) throw new Error("scan roots must be an array");
  if (roots.length === 0) {
    deleteKey(db, KEY_SCAN_ROOTS);
    return [];
  }
  if (roots.length > MAX_ROOTS) throw new Error(`too many roots (max ${MAX_ROOTS})`);

  const canonical: string[] = [];
  const errors: string[] = [];
  for (const raw of roots) {
    if (typeof raw !== "string" || raw.trim() === "") {
      errors.push("empty or non-string path");
      continue;
    }
    const p = raw.trim();
    if (p.includes(String.fromCharCode(0))) {
      errors.push(`${p}: contains NUL`);
      continue;
    }
    if (p.length > MAX_PATH_LEN) {
      errors.push(`path too long (max ${MAX_PATH_LEN})`);
      continue;
    }
    if (!isAbsolute(p)) {
      errors.push(`${p}: not an absolute path`);
      continue;
    }
    const canon = canonicalizePath(p); // realpathSync -> null if it doesn't exist
    if (!canon) {
      errors.push(`${p}: does not exist`);
      continue;
    }
    try {
      if (!statSync(canon).isDirectory()) {
        errors.push(`${p}: not a directory`);
        continue;
      }
    } catch {
      errors.push(`${p}: not accessible`);
      continue;
    }
    canonical.push(canon);
  }

  if (errors.length > 0) throw new Error(`invalid scan roots: ${errors.join("; ")}`);

  const deduped = [...new Set(canonical)];
  writeRaw(db, KEY_SCAN_ROOTS, deduped);
  return deduped;
}

/**
 * Repo-discovery depth brake (levels below a scan root). Returns the configured
 * value or {@link DEFAULT_SCAN_MAX_DEPTH}; a missing / corrupt / out-of-range row
 * resolves to the default (corruption-tolerant).
 */
export function getScanMaxDepth(db: Database.Database): number {
  const raw = readRaw(db, KEY_SCAN_MAX_DEPTH);
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > MAX_SCAN_DEPTH) {
    if (raw !== undefined) console.warn("app_config: scan.maxDepth out of range; using default");
    return DEFAULT_SCAN_MAX_DEPTH;
  }
  return raw;
}

/** Validate + store the depth brake. Throws (caller -> 400) on a non-integer or out-of-range value. */
export function setScanMaxDepth(db: Database.Database, depth: number): number {
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0 || depth > MAX_SCAN_DEPTH) {
    throw new Error(`scan depth must be an integer 0..${MAX_SCAN_DEPTH}`);
  }
  writeRaw(db, KEY_SCAN_MAX_DEPTH, depth);
  return depth;
}
