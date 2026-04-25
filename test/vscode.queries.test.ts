import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { listVscodeRecentProjects } from "../src/vscode/queries.js";
import { openDatabase } from "../src/store/open.js";

describe("VS Code recent project queries", () => {
  it("aggregates all active entries before applying project limits and links repos by longest prefix", () => {
    const base = join(tmpdir(), `ai2nao-vscode-queries-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    const db = openDatabase(join(base, "idx.db"));
    try {
      db.prepare(
        `INSERT INTO repos (path_canonical, origin_url, first_seen_at)
         VALUES (?, ?, 'now'), (?, ?, 'now')`
      ).run("/tmp/work", "https://example.com/work.git", "/tmp/work/app", "https://example.com/app.git");
      const insert = db.prepare(
        `INSERT INTO vscode_recent_entries (
          app, profile, kind, recent_index, uri_redacted, path, label,
          exists_on_disk, first_seen_at, last_seen_at, inserted_at, updated_at
        ) VALUES ('code', 'default', ?, ?, ?, ?, ?, 1, 'now', 'now', 'now', 'now')`
      );
      insert.run("file", 0, "file:///tmp/work/app/src/main.ts", "/tmp/work/app/src/main.ts", "main.ts");
      insert.run("folder", 1, "file:///tmp/work/app", "/tmp/work/app", "app");
      insert.run("folder", 2, "file:///tmp/other", "/tmp/other", "other");

      const res = listVscodeRecentProjects(db, {
        includeMissing: false,
        limit: 1,
        offset: 0,
      });

      expect(res.total).toBe(2);
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({
        key: "repo:2",
        label: "app",
        entryCount: 2,
        latestRecentIndex: 0,
      });
      expect(res.rows[0].repo?.path_canonical).toBe("/tmp/work/app");
    } finally {
      db.close();
    }
  });
});
