import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";

describe("VS Code routes", () => {
  it("lists redacted recent entries and rejects invalid app ids", async () => {
    const base = join(tmpdir(), `ai2nao-vscode-routes-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    const db = openDatabase(join(base, "idx.db"));
    try {
      db.prepare(
        `INSERT INTO vscode_recent_entries (
          app, profile, kind, recent_index, uri_redacted, path, label,
          remote_type, remote_authority_hash, remote_path_hash, exists_on_disk,
          first_seen_at, last_seen_at, inserted_at, updated_at
        ) VALUES (
          'code', 'default', 'folder', 0, 'ssh-remote://abc123/def456', NULL, 'private',
          'ssh-remote', 'abc123', 'def456', NULL, 'now', 'now', 'now', 'now'
        )`
      ).run();
      const app = createApp({ db });
      const res = await app.request("http://x/api/vscode/recent?scope=remote");
      expect(res.status).toBe(200);
      const bodyText = await res.text();
      expect(bodyText).toContain("abc123");
      expect(bodyText).not.toContain("alice");
      expect(bodyText).not.toContain("example.com");

      const bad = await app.request("http://x/api/vscode/status?app=nope");
      expect(bad.status).toBe(400);
    } finally {
      db.close();
    }
  });
});
