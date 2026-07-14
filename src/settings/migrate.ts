import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { defaultRagConfigPath } from "../config.js";
import { CREDENTIAL_SPECS } from "./schema.js";
import { CREDENTIAL_NAMES, type CredentialName, configDb } from "./store.js";

/**
 * One-time import of credentials from the JSON files (and index.db's
 * `provider_config.api_key`) into config.db.
 *
 * Three properties this has to hold, each learned the hard way:
 *
 * 1. **It never translates.** A credential's value_json is byte-for-byte what
 *    the file's parser produced, so migration cannot mangle a config.
 * 2. **It never deletes.** Migrated files are renamed to `*.migrated`, so a bad
 *    migration is recoverable by hand. `rag.json` is not renamed at all — it
 *    also holds corpusRoots, which are not credentials and must survive.
 * 3. **It writes the marker before touching any file.** If the process dies
 *    between commit and rename, the next run sees the marker, skips the import,
 *    and leaves a stale file that nothing reads (db out-ranks it). The reverse
 *    order could rename a file whose contents were never committed — losing the
 *    key.
 */

const MARKER_KEY = "config.migratedAt";

export type MigrationResult = {
  migrated: CredentialName[];
  /** Already done (marker present) — this is the normal, boring case. */
  skipped: boolean;
};

/** The `embedding` block of rag.json — the only part of that file that moves. */
function ragEmbeddingFromFile(): string | null {
  // Honour AI2NAO_RAG_CONFIG like readRagConfig does, so a redirected test can't
  // end up reading the developer's real rag.json.
  const override = (process.env.AI2NAO_RAG_CONFIG ?? "").trim();
  const path = override ? resolve(override) : defaultRagConfigPath();
  if (!existsSync(path)) return null;
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof data !== "object" || data === null) return null;
    const embedding = (data as { embedding?: unknown }).embedding;
    if (!embedding) return null;
    const raw = JSON.stringify(embedding);
    return CREDENTIAL_SPECS["rag-embedding"].parse(raw) ? raw : null;
  } catch {
    return null;
  }
}

function legacyValue(name: CredentialName): string | null {
  if (name === "rag-embedding") return ragEmbeddingFromFile();
  const spec = CREDENTIAL_SPECS[name];
  if (!spec.legacyPath) return null;
  const path = spec.legacyPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = spec.parse(readFileSync(path, "utf8"));
    return parsed ? JSON.stringify(parsed) : null;
  } catch {
    return null;
  }
}

function minimaxKeyFromIndexDb(indexDb: Database.Database): string | null {
  try {
    const row = indexDb
      .prepare("SELECT api_key FROM provider_config WHERE provider = 'minimax'")
      .get() as { api_key: string | null } | undefined;
    const key = row?.api_key?.trim();
    return key ? JSON.stringify({ apiKey: key }) : null;
  } catch {
    return null; // table may not exist yet on a fresh install
  }
}

/**
 * Runs on every startup; does real work exactly once. `indexDb` is only needed
 * to lift the MiniMax key out of `provider_config` — pass null to skip that.
 */
export function migrateCredentials(indexDb: Database.Database | null): MigrationResult {
  const cfg = configDb();
  if (!cfg) return { migrated: [], skipped: true }; // store degraded; nothing to do

  // BEGIN IMMEDIATE takes the write lock up front, so two processes starting at
  // once can't both read "no marker" and both import.
  const run = cfg.transaction((): CredentialName[] => {
    const marker = cfg
      .prepare("SELECT value FROM config_meta WHERE key = ?")
      .get(MARKER_KEY) as { value: string } | undefined;
    if (marker) return [];

    const done: CredentialName[] = [];
    for (const name of CREDENTIAL_NAMES) {
      const value =
        name === "minimax"
          ? indexDb
            ? minimaxKeyFromIndexDb(indexDb)
            : null
          : legacyValue(name);
      if (!value) continue;
      cfg
        .prepare(
          `INSERT INTO credential (name, value_json, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(name) DO NOTHING`
        )
        .run(name, value);
      done.push(name);
    }

    // Marker first, inside the same transaction as the imports: committed
    // together or not at all.
    cfg
      .prepare("INSERT INTO config_meta (key, value) VALUES (?, datetime('now'))")
      .run(MARKER_KEY);
    return done;
  });

  let migrated: CredentialName[];
  try {
    migrated = run.immediate();
  } catch (e) {
    console.error(
      `warning: credential migration failed (${e instanceof Error ? e.message : String(e)}); ` +
        `continuing to read config from the existing files.`
    );
    return { migrated: [], skipped: true };
  }

  if (migrated.length === 0) return { migrated, skipped: true };

  // Only now — after the keys are durably in config.db — retire the old files.
  for (const name of migrated) {
    if (name === "rag-embedding" || name === "minimax") continue; // no file of their own
    const path = CREDENTIAL_SPECS[name].legacyPath?.();
    if (!path) continue;
    try {
      renameSync(path, `${path}.migrated`);
    } catch {
      // ENOENT = another process got there first; anything else is benign too:
      // config.db already out-ranks the file, so a leftover is inert.
    }
  }

  // The MiniMax key is now in config.db; blank the plaintext column so it stops
  // riding along in every backup of the (large, un-excludable) index.db.
  if (migrated.includes("minimax") && indexDb) {
    try {
      indexDb.prepare("UPDATE provider_config SET api_key = NULL WHERE provider = 'minimax'").run();
    } catch {
      /* best-effort; providerApiKey() prefers config.db either way */
    }
  }

  console.error(`ai2nao: moved ${migrated.length} credential(s) into config.db (0600).`);
  return { migrated, skipped: false };
}
