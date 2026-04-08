import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "./migrations.js";

export function openDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

/** Read-only open for tests or tools that must not migrate or write the main index. */
export function openReadOnlyDatabase(dbPath: string): Database.Database {
  if (!existsSync(dbPath)) {
    throw new Error(`Database file not found: ${dbPath}`);
  }
  return new Database(dbPath, { fileMustExist: true, readonly: true });
}
