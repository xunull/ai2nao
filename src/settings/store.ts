import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { defaultConfigDbPath } from "../config.js";
import { secureFile } from "../util/filePerms.js";

/**
 * Credential store — `~/.ai2nao/config.db` (0600).
 *
 * Dumb on purpose: it stores an opaque JSON string per name and knows nothing
 * about what's inside. Each feature keeps parsing with the parser it already
 * had (`parseLlmChatConfigJson`, `parseNotifyConfigJson`, …), so the JSON in
 * this table is byte-for-byte the JSON that used to sit in the file — which is
 * also why migration is a copy, not a translation. Keeping schema knowledge OUT
 * of here is what stops an import cycle: readers depend on this module, so this
 * module must not depend on readers. See `src/settings/schema.ts` for the
 * name → parser registry (imported only by leaves: routes and migration).
 *
 * Values are NOT cached in memory — only the db handle is. A read is one
 * prepared statement against a few-KB table (microseconds, next to a
 * multi-hundred-ms LLM call), and paying it every time means a config change
 * from ANY process is visible immediately. No cache invalidation, no
 * "restart serve after editing config".
 */

export type CredentialName =
  | "llm-chat"
  | "rag-embedding"
  | "web-search"
  | "github"
  | "feishu"
  | "minimax";

export const CREDENTIAL_NAMES: readonly CredentialName[] = [
  "llm-chat",
  "rag-embedding",
  "web-search",
  "github",
  "feishu",
  "minimax",
] as const;

/**
 * Names of non-secret settings kept in config.db.
 *
 * A setting and a credential are stored identically — one opaque JSON blob per
 * name — and share every access path (parse, merge-patch, mask rejection). The
 * ONLY difference is that a setting has no secret fields to redact, so it can be
 * shown back to the UI verbatim. They live in separate tables purely so the
 * table name doesn't lie: nobody wants to find `corpusRoots` inside a table
 * called `credential`. (Renaming `credential` itself was rejected — config.db
 * has no migration runner, so a rename would orphan every stored key.)
 */
export type SettingName = "rag-corpus";

export const SETTING_NAMES: readonly SettingName[] = ["rag-corpus"] as const;

/** The two entry tables, keyed by a closed enum — never an interpolated string. */
const ENTRY_TABLE = { credential: "credential", setting: "setting" } as const;
type EntryTable = keyof typeof ENTRY_TABLE;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS credential (
  name       TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS setting (
  name       TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS config_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** `undefined` = not opened yet; `null` = open failed, degrade to "nothing configured". */
let handle: Database.Database | null | undefined;
/** Which path `handle` was opened from — see the re-open check in `db()`. */
let openedPath: string | undefined;
let degradeWarned = false;

export function configDbPath(): string {
  const override = (process.env.AI2NAO_CONFIG_DB ?? "").trim();
  if (override.length > 0) return resolve(override);
  if (process.env.VITEST) {
    // Fail closed. A test that reaches the default path would read the
    // developer's real API keys — and, as happened once, write to them.
    // test/setup/isolateCredentials.ts sets the override for every test file;
    // if that ever stops running, this throws instead of silently obliging.
    throw new Error(
      "refusing to open the real ~/.ai2nao/config.db under VITEST — set AI2NAO_CONFIG_DB"
    );
  }
  return defaultConfigDbPath();
}

/**
 * A corrupt or unopenable config.db must not brick the app: it degrades to
 * "no credentials configured", which every feature already handles (missing
 * config = feature off). Bricking on a broken settings file is a worse failure
 * than running with the feature disabled.
 */
function db(): Database.Database | null {
  const path = configDbPath();
  // Re-open when AI2NAO_CONFIG_DB now points somewhere else. In production it
  // never does; in tests it is what gives each case a clean store WITHOUT every
  // test file having to import this module (and drag better-sqlite3 into a few
  // hundred React tests) just to call a reset.
  if (handle !== undefined && openedPath === path) return handle;
  if (handle) {
    try {
      handle.close();
    } catch {
      /* already gone */
    }
  }
  openedPath = path;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const d = new Database(path);
    // chmod BEFORE the first write: SQLite gives the rollback journal the mode
    // the main db has when the journal is created. No WAL here — this db is
    // tiny and rarely written, and skipping WAL means no -wal/-shm sidecars to
    // leak a key from.
    secureFile(path, "config.db");
    d.pragma("busy_timeout = 5000");
    d.exec(SCHEMA);
    handle = d;
  } catch (e) {
    if (!degradeWarned) {
      degradeWarned = true;
      console.error(
        `warning: could not open ${path} (${e instanceof Error ? e.message : String(e)}); ` +
          `running with no stored credentials.`
      );
    }
    handle = null;
  }
  return handle;
}

// ---- generic entry accessors (credential + setting share one implementation) ----

function getRaw(table: EntryTable, name: string): string | null {
  const d = db();
  if (!d) return null;
  try {
    const row = d
      .prepare(`SELECT value_json FROM ${ENTRY_TABLE[table]} WHERE name = ?`)
      .get(name) as { value_json: string } | undefined;
    return row?.value_json ?? null;
  } catch {
    return null;
  }
}

function setRaw(table: EntryTable, name: string, valueJson: string): void {
  const d = db();
  if (!d) throw new Error("config store unavailable");
  d.prepare(
    `INSERT INTO ${ENTRY_TABLE[table]} (name, value_json, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(name) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(name, valueJson);
}

function deleteRaw(table: EntryTable, name: string): void {
  const d = db();
  if (!d) return;
  d.prepare(`DELETE FROM ${ENTRY_TABLE[table]} WHERE name = ?`).run(name);
}

/** Raw JSON string for a credential, or null when unset / store unavailable. */
export function getCredentialRaw(name: CredentialName): string | null {
  return getRaw("credential", name);
}

/** Throws if the store is unavailable — a failed write must never look like a success. */
export function setCredentialRaw(name: CredentialName, valueJson: string): void {
  setRaw("credential", name, valueJson);
}

export function deleteCredential(name: CredentialName): void {
  deleteRaw("credential", name);
}

/** Raw JSON string for a setting, or null when unset / store unavailable. */
export function getSettingRaw(name: SettingName): string | null {
  return getRaw("setting", name);
}

export function setSettingRaw(name: SettingName, valueJson: string): void {
  setRaw("setting", name, valueJson);
}

export function deleteSetting(name: SettingName): void {
  deleteRaw("setting", name);
}

export function getConfigMeta(key: string): string | null {
  const d = db();
  if (!d) return null;
  try {
    const row = d.prepare("SELECT value FROM config_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function setConfigMeta(key: string, value: string): void {
  const d = db();
  if (!d) throw new Error("credential store unavailable");
  d.prepare(
    `INSERT INTO config_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

/** Escape hatch for migration, which needs BEGIN IMMEDIATE across several writes. */
export function configDb(): Database.Database | null {
  return db();
}

/**
 * Tests MUST call this (with AI2NAO_CONFIG_DB pointed at a temp file), or a
 * process-level singleton would happily read the developer's real credentials.
 */
export function resetSettingsForTest(): void {
  try {
    handle?.close();
  } catch {
    /* already closed */
  }
  handle = undefined;
  openedPath = undefined;
  degradeWarned = false;
}
