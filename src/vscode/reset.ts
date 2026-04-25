import type Database from "better-sqlite3";

export function resetVscodeRecent(db: Database.Database): {
  deletedRows: number;
  deletedState: number;
} {
  const deletedRows = db.prepare("DELETE FROM vscode_recent_entries").run().changes;
  const deletedState = db.prepare("DELETE FROM vscode_sync_state").run().changes;
  return { deletedRows, deletedState };
}
