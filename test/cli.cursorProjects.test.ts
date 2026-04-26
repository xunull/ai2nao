import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/open.js";
import { setVscodeSyncStateValue } from "../src/vscode/state.js";

function runCli(args: string[]): string {
  return execFileSync("node", ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("Cursor projects CLI", () => {
  it("reports Cursor status and resets only Cursor opened-project rows", () => {
    const base = join(tmpdir(), `ai2nao-cli-cursor-projects-${Date.now()}-${Math.random()}`);
    mkdirSync(base, { recursive: true });
    const dbPath = join(base, "idx.db");
    const db = openDatabase(dbPath);
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
    } finally {
      db.close();
    }

    const status = JSON.parse(runCli(["cursor", "projects", "status", "--db", dbPath, "--json"])) as {
      app: string;
      counts: { active: number };
    };
    expect(status.app).toBe("cursor");
    expect(status.counts.active).toBe(1);

    const reset = JSON.parse(
      runCli(["cursor", "projects", "reset", "--db", dbPath, "--yes", "--json"])
    ) as { ok: boolean; app: string; deletedRows: number; deletedState: number };
    expect(reset).toMatchObject({ ok: true, app: "cursor", deletedRows: 1, deletedState: 0 });

    const verify = openDatabase(dbPath);
    try {
      expect(verify.prepare("SELECT app FROM vscode_recent_entries").all()).toEqual([{ app: "code" }]);
      expect(
        verify.prepare("SELECT value FROM vscode_sync_state WHERE key = ?").get("privacy.remote_hash_salt")
      ).toEqual({ value: "salt" });
    } finally {
      verify.close();
    }
  });
});
