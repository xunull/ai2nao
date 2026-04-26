import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/open.js";
import { resetVscodeRecent } from "../src/vscode/reset.js";
import { setVscodeSyncStateValue } from "../src/vscode/state.js";

describe("VS Code recent reset", () => {
  it("deletes only the requested app rows and preserves shared privacy salt", () => {
    const base = join(tmpdir(), `ai2nao-vscode-reset-${Date.now()}-${Math.random()}`);
    mkdirSync(base, { recursive: true });
    const db = openDatabase(join(base, "idx.db"));
    try {
      const insert = db.prepare(
        `INSERT INTO vscode_recent_entries (
          app, profile, kind, recent_index, uri_redacted, path, label,
          exists_on_disk, first_seen_at, last_seen_at, inserted_at, updated_at
        ) VALUES (?, 'default', 'folder', 0, ?, ?, ?, 1, 'now', 'now', 'now', 'now')`
      );
      insert.run("code", "file:///tmp/code", "/tmp/code", "code");
      insert.run("cursor", "file:///tmp/cursor", "/tmp/cursor", "cursor");
      setVscodeSyncStateValue(db, "privacy.remote_hash_salt", "salt", "now");

      const result = resetVscodeRecent(db, { app: "cursor" });

      expect(result).toEqual({ app: "cursor", deletedRows: 1, deletedState: 0 });
      expect(
        db.prepare("SELECT app FROM vscode_recent_entries ORDER BY app").all()
      ).toEqual([{ app: "code" }]);
      expect(
        db.prepare("SELECT value FROM vscode_sync_state WHERE key = ?").get(
          "privacy.remote_hash_salt"
        )
      ).toEqual({ value: "salt" });
    } finally {
      db.close();
    }
  });
});
