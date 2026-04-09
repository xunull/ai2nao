import BetterSqlite from "better-sqlite3";
import type Database from "better-sqlite3";

/**
 * Read-only open for Cursor `state.vscdb` files. Never run migrations or writes.
 */
export function openCursorSqlite(absolutePath: string): Database.Database {
  return new BetterSqlite(absolutePath, { readonly: true, fileMustExist: true });
}
