import type Database from "better-sqlite3";

export function setSoftwareSyncStateValue(
  db: Database.Database,
  key: string,
  value: string | null
): void {
  if (value == null) {
    db.prepare("DELETE FROM software_sync_state WHERE key = ?").run(key);
    return;
  }
  db.prepare(
    `INSERT INTO software_sync_state (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

export function getSoftwareSyncStateValue(
  db: Database.Database,
  key: string
): string | null {
  const row = db
    .prepare("SELECT value FROM software_sync_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
