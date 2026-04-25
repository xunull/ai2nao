import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export function getVscodeSyncStateValue(
  db: Database.Database,
  key: string
): string | null {
  const row = db
    .prepare("SELECT value FROM vscode_sync_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setVscodeSyncStateValue(
  db: Database.Database,
  key: string,
  value: string,
  nowIso: string
): void {
  db.prepare(
    `INSERT INTO vscode_sync_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, nowIso);
}

export function getOrCreateRemoteHashSalt(
  db: Database.Database,
  nowIso: string
): string {
  const existing = getVscodeSyncStateValue(db, "privacy.remote_hash_salt");
  if (existing) return existing;
  const salt = randomBytes(32).toString("hex");
  setVscodeSyncStateValue(db, "privacy.remote_hash_salt", salt, nowIso);
  return salt;
}
