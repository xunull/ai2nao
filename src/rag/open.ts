import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { migrateRag } from "./migrations.js";

export function openRagDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  migrateRag(db);
  return db;
}

export function openRagReadOnlyDatabase(dbPath: string): Database.Database {
  if (!existsSync(dbPath)) {
    throw new Error(`RAG database not found: ${dbPath}`);
  }
  return new Database(dbPath, { fileMustExist: true, readonly: true });
}
