import { chmodSync, existsSync, statSync } from "node:fs";

/**
 * Owner-only file permissions for anything that can hold a secret.
 *
 * Why this exists: ai2nao's DBs and config files were created with the default
 * umask (0644 on macOS) and NOTHING ever chmod'd them — so `index.db` (which
 * holds `provider_config.api_key` in plaintext) and `llm-chat.json` / `rag.json`
 * / `web-search.json` (which hold API keys) were group/other-readable.
 *
 * Scope note, so nobody over-trusts this: 0600 protects against OTHER UNIX USERS
 * on this machine. It does nothing against Time Machine / Dropbox / rsync — those
 * run as you. That's a separate argument (and the reason secrets belong in a
 * small, excludable config.db rather than the 744MB index.db).
 */

const OWNER_ONLY = 0o600;
/** group-readable | group-writable | other-readable | other-writable */
const GROUP_OR_OTHER = 0o077;

const warned = new Set<string>();

/** True when anyone other than the owner can read or write this file. */
export function isGroupOrOtherAccessible(path: string): boolean {
  try {
    return (statSync(path).mode & GROUP_OR_OTHER) !== 0;
  } catch {
    return false;
  }
}

/**
 * chmod 0600 if the file is loose. Idempotent, never throws (a read-only mount
 * or a file we don't own must not take the process down).
 * Returns true when it actually tightened something.
 */
export function secureFile(path: string, label?: string): boolean {
  if (!existsSync(path)) return false;
  if (!isGroupOrOtherAccessible(path)) return false;
  try {
    chmodSync(path, OWNER_ONLY);
    if (!warned.has(path)) {
      warned.add(path);
      console.error(
        `warning: ${label ?? path} was group/other-readable; tightened to 0600.`
      );
    }
    return true;
  } catch {
    if (!warned.has(path)) {
      warned.add(path);
      console.error(
        `warning: ${label ?? path} is group/other-readable and could not be chmod'd to 0600.`
      );
    }
    return false;
  }
}

/**
 * Secure a SQLite database and its WAL sidecars.
 *
 * The sidecars matter: `-wal` holds recently-written pages (a key you just saved
 * lives there before checkpoint) and `-shm` is the shared-memory index. SQLite
 * creates them matching the MAIN db's mode at the time they're created — so the
 * caller must chmod the main db BEFORE enabling WAL, and this function mops up
 * any sidecars that already exist from an earlier, looser run.
 */
export function secureDatabaseFiles(dbPath: string): void {
  secureFile(dbPath);
  secureFile(`${dbPath}-wal`);
  secureFile(`${dbPath}-shm`);
}

export const __testing = { OWNER_ONLY, GROUP_OR_OTHER };
