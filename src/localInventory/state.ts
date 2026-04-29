import type Database from "better-sqlite3";

export function setInventorySyncStateValue(
  db: Database.Database,
  key: string,
  value: string | null
): void {
  if (value == null) {
    db.prepare("DELETE FROM local_inventory_sync_state WHERE key = ?").run(key);
    return;
  }
  db.prepare(
    `INSERT INTO local_inventory_sync_state (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

export function getInventorySyncStateValue(
  db: Database.Database,
  key: string
): string | null {
  const row = db
    .prepare("SELECT value FROM local_inventory_sync_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
