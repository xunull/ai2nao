import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { secureDatabaseFiles, secureFile } from "../util/filePerms.js";
import { migrate } from "./migrations.js";

/** Wait this long for a competing writer instead of throwing SQLITE_BUSY immediately. */
const BUSY_TIMEOUT_MS = 5_000;

export function openDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  // Order matters. SQLite creates `-wal` / `-shm` with the mode of the MAIN db
  // file at the moment they are created, so the main file must be 0600 BEFORE
  // WAL is enabled — otherwise the sidecars (which hold recently-written pages,
  // including a secret you just saved) inherit 0644.
  secureFile(dbPath);
  db.pragma("journal_mode = WAL");
  // Mop up sidecars left 0644 by an earlier run that predates this fix.
  secureDatabaseFiles(dbPath);

  // Without this, a write racing another writer (CLI vs server vs scheduler)
  // throws SQLITE_BUSY instantly instead of waiting.
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

  migrate(db);
  return db;
}

/** Read-only open for tests or tools that must not migrate or write the main index. */
export function openReadOnlyDatabase(dbPath: string): Database.Database {
  if (!existsSync(dbPath)) {
    throw new Error(`Database file not found: ${dbPath}`);
  }
  // Still tighten: a read-only consumer shouldn't leave a world-readable DB behind.
  secureDatabaseFiles(dbPath);
  return new Database(dbPath, { fileMustExist: true, readonly: true });
}
