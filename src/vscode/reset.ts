import type Database from "better-sqlite3";
import { parseVscodeAppId } from "./paths.js";
import type { VscodeAppId } from "./types.js";

export function resetVscodeRecent(
  db: Database.Database,
  opts: { app?: string } = {}
): {
  app: VscodeAppId;
  deletedRows: number;
  deletedState: number;
} {
  const app = parseVscodeAppId(opts.app ?? "code");
  if (!app) throw new Error("invalid app");
  const deletedRows = db.prepare("DELETE FROM vscode_recent_entries WHERE app = ?").run(app)
    .changes;
  return { app, deletedRows, deletedState: 0 };
}
