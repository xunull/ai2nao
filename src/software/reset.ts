import type Database from "better-sqlite3";
import type { SoftwareSource } from "./types.js";

export type ResetSoftwareResult = {
  source: SoftwareSource;
  deletedRows: number;
  deletedRuns: number;
  deletedState: number;
};

export function resetSoftwareSource(
  db: Database.Database,
  source: SoftwareSource
): ResetSoftwareResult {
  const tx = db.transaction(() => {
    const deletedRows =
      source === "mac_apps"
        ? db.prepare("DELETE FROM mac_apps").run().changes
        : db.prepare("DELETE FROM brew_packages").run().changes;
    const statePrefix = source === "mac_apps" ? "mac_apps.%" : "brew.%";
    const deletedState = db
      .prepare("DELETE FROM software_sync_state WHERE key LIKE ?")
      .run(statePrefix).changes;
    const deletedRuns = db
      .prepare("DELETE FROM software_sync_runs WHERE source = ?")
      .run(source).changes;
    return { source, deletedRows, deletedRuns, deletedState };
  });
  return tx();
}
