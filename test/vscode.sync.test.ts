import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/open.js";
import { syncVscodeRecent } from "../src/vscode/sync.js";

function makeBase(name: string) {
  const base = join(tmpdir(), `ai2nao-${name}-${Date.now()}-${Math.random()}`);
  mkdirSync(base, { recursive: true });
  return base;
}

function makeStateDb(path: string, value: string | null) {
  const db = new Database(path);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  if (value != null) {
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "history.recentlyOpenedPathsList",
      value
    );
  }
  db.close();
}

describe("VS Code recent sync", () => {
  it("syncs local and remote entries without storing raw remote authority", () => {
    const base = makeBase("vscode-sync");
    const project = join(base, "project");
    mkdirSync(project);
    const statePath = join(base, "state.vscdb");
    makeStateDb(
      statePath,
      JSON.stringify({
        entries: [
          { folderUri: `file://${project}`, label: "project" },
          {
            folderUri: "vscode-remote://ssh-remote+alice@example.com/home/alice/private",
            remoteAuthority: "ssh-remote+alice@example.com",
            label: "private",
          },
        ],
      })
    );
    const db = openDatabase(join(base, "idx.db"));
    try {
      const result = syncVscodeRecent(db, { sourcePath: statePath, now: new Date("2026-04-25T00:00:00Z") });
      expect(result.ok).toBe(true);
      expect(result.inserted).toBe(2);
      const raw = JSON.stringify(
        db.prepare("SELECT * FROM vscode_recent_entries ORDER BY recent_index").all()
      );
      expect(raw).not.toContain("alice");
      expect(raw).not.toContain("example.com");
      expect(raw).toContain("project");
    } finally {
      db.close();
    }
  });

  it("does not mutate existing rows on fatal parse failure", () => {
    const base = makeBase("vscode-sync-fail");
    const goodState = join(base, "good.vscdb");
    const badState = join(base, "bad.vscdb");
    makeStateDb(goodState, JSON.stringify({ entries: [{ folderUri: `file://${base}`, label: "base" }] }));
    makeStateDb(badState, "{not-json");
    const db = openDatabase(join(base, "idx.db"));
    try {
      expect(syncVscodeRecent(db, { sourcePath: goodState }).ok).toBe(true);
      const before = db.prepare("SELECT COUNT(*) AS n FROM vscode_recent_entries").get() as { n: number };
      const failed = syncVscodeRecent(db, { sourcePath: badState });
      expect(failed.ok).toBe(false);
      const after = db.prepare("SELECT COUNT(*) AS n FROM vscode_recent_entries").get() as { n: number };
      expect(after.n).toBe(before.n);
    } finally {
      db.close();
    }
  });

  it("does not create privacy state on invalid top-level source shape", () => {
    const base = makeBase("vscode-sync-invalid-shape");
    const badState = join(base, "bad-shape.vscdb");
    makeStateDb(badState, JSON.stringify({ nope: [] }));
    const db = openDatabase(join(base, "idx.db"));
    try {
      const failed = syncVscodeRecent(db, { sourcePath: badState });
      expect(failed.ok).toBe(false);
      const state = db.prepare("SELECT COUNT(*) AS n FROM vscode_sync_state").get() as { n: number };
      const rows = db.prepare("SELECT COUNT(*) AS n FROM vscode_recent_entries").get() as { n: number };
      expect(state.n).toBe(0);
      expect(rows.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("uses Cursor-specific messages without creating privacy state on invalid Cursor source shape", () => {
    const base = makeBase("cursor-sync-invalid-shape");
    const badState = join(base, "bad-cursor-shape.vscdb");
    makeStateDb(badState, JSON.stringify({ nope: [] }));
    const db = openDatabase(join(base, "idx.db"));
    try {
      const failed = syncVscodeRecent(db, { app: "cursor", sourcePath: badState });
      expect(failed.ok).toBe(false);
      expect(failed.warnings[0]?.message).toContain("Cursor recent list");
      const state = db.prepare("SELECT COUNT(*) AS n FROM vscode_sync_state").get() as { n: number };
      const rows = db.prepare("SELECT COUNT(*) AS n FROM vscode_recent_entries").get() as { n: number };
      expect(state.n).toBe(0);
      expect(rows.n).toBe(0);
    } finally {
      db.close();
    }
  });
});
