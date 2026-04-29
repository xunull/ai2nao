import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  getDirectoryActivityStatus,
  listDirectoryActivityCommands,
  listTopDirectoryActivityDirs,
  rebuildDirectoryActivity,
} from "../src/atuin/directoryActivity/index.js";
import { openDatabase } from "../src/store/open.js";

function tempBase(): string {
  const base = join(tmpdir(), `ai2nao-dir-activity-${Date.now()}-${Math.random()}`);
  mkdirSync(base, { recursive: true });
  return base;
}

function indexDb(): BetterSqlite3.Database {
  return openDatabase(join(tempBase(), "index.db"));
}

function atuinDb(): BetterSqlite3.Database {
  const db = new Database(join(tempBase(), "history.db"));
  db.exec(`
    CREATE TABLE history (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      duration INTEGER NOT NULL,
      exit INTEGER NOT NULL,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      session TEXT NOT NULL,
      hostname TEXT NOT NULL,
      deleted_at INTEGER
    );
  `);
  return db;
}

function insertHistory(
  db: BetterSqlite3.Database,
  row: { id: string; ts: number; command: string; cwd: string; exit?: number; deleted?: boolean }
): void {
  db.prepare(
    `INSERT INTO history (
      id, timestamp, duration, exit, command, cwd, session, hostname, deleted_at
    ) VALUES (?, ?, 0, ?, ?, ?, 's', 'h', ?)`
  ).run(row.id, row.ts, row.exit ?? 0, row.command, row.cwd, row.deleted ? row.ts : null);
}

describe("Atuin directory activity", () => {
  it("rebuilds raw and filtered directory/command aggregates", () => {
    const index = indexDb();
    const source = atuinDb();
    try {
      insertHistory(source, { id: "1", ts: 1, command: "git status", cwd: "/repo" });
      insertHistory(source, { id: "2", ts: 2, command: "npm test", cwd: "/repo", exit: 1 });
      insertHistory(source, { id: "3", ts: 3, command: "npm test", cwd: "/repo" });
      insertHistory(source, { id: "4", ts: 4, command: "clear", cwd: "/repo", deleted: true });
      insertHistory(source, { id: "5", ts: 5, command: "pnpm build", cwd: "/other" });

      const result = rebuildDirectoryActivity({ indexDb: index, atuinDb: source });
      expect(result).toMatchObject({
        ok: true,
        sourceEntryCount: 4,
        derivedDirectoryCount: 2,
        derivedCommandCount: 3,
      });

      const dirs = listTopDirectoryActivityDirs(index, { mode: "filtered" });
      expect(dirs[0]).toMatchObject({
        cwd: "/repo",
        raw_command_count: 3,
        filtered_command_count: 2,
        raw_failed_count: 1,
        filtered_failed_count: 1,
        last_exit: 0,
      });

      const commands = listDirectoryActivityCommands(index, {
        cwd: "/repo",
        mode: "filtered",
      });
      expect(commands.map((row) => [row.command, row.raw_count, row.filtered_count])).toEqual([
        ["npm test", 2, 2],
        ["git status", 1, 0],
      ]);

      const status = getDirectoryActivityStatus(index);
      expect(status.fresh).toBe(true);
      expect(status.staleReasons).toEqual([]);
      expect(status.state?.source_entry_count).toBe(4);
    } finally {
      source.close();
      index.close();
    }
  });

  it("records schema mismatch without deleting previous derived rows", () => {
    const index = indexDb();
    const source = atuinDb();
    try {
      insertHistory(source, { id: "1", ts: 1, command: "npm test", cwd: "/repo" });
      expect(rebuildDirectoryActivity({ indexDb: index, atuinDb: source }).ok).toBe(true);
      source.exec("DROP TABLE history");
      source.exec("CREATE TABLE history (id TEXT PRIMARY KEY)");

      const result = rebuildDirectoryActivity({ indexDb: index, atuinDb: source });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("schema_mismatch");
      expect(listTopDirectoryActivityDirs(index, { mode: "raw" })).toHaveLength(1);
      const status = getDirectoryActivityStatus(index);
      expect(status.staleReasons).toContain("last_rebuild_error");
    } finally {
      source.close();
      index.close();
    }
  });
});
