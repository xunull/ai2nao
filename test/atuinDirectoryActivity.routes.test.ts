import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { openDatabase, openReadOnlyDatabase } from "../src/store/open.js";

describe("Atuin directory activity routes", () => {
  it("rebuilds and serves top directories and commands", async () => {
    const base = join(tmpdir(), `ai2nao-dir-routes-${Date.now()}-${Math.random()}`);
    mkdirSync(base, { recursive: true });
    const indexPath = join(base, "index.db");
    const atuinPath = join(base, "history.db");
    const index = openDatabase(indexPath);
    const sourceWrite = new Database(atuinPath);
    sourceWrite.exec(`
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
      INSERT INTO history (id, timestamp, duration, exit, command, cwd, session, hostname)
      VALUES
        ('1', 1, 0, 0, 'git status', '/repo', 's', 'h'),
        ('2', 2, 0, 0, 'npm test', '/repo', 's', 'h');
    `);
    sourceWrite.close();
    const source = openReadOnlyDatabase(atuinPath);
    try {
      const app = createApp({ db: index, atuin: { db: source, path: atuinPath } });
      const rebuild = await app.request("http://x/api/atuin/directories/rebuild", {
        method: "POST",
      });
      expect(rebuild.status).toBe(200);

      const status = await app.request("http://x/api/atuin/directories/status");
      expect(status.status).toBe(200);
      const statusJson = (await status.json()) as {
        directoryActivity: { fresh: boolean; state: { source_entry_count: number } };
      };
      expect(statusJson.directoryActivity.fresh).toBe(true);
      expect(statusJson.directoryActivity.state.source_entry_count).toBe(2);

      const top = await app.request("http://x/api/atuin/directories/top?mode=filtered");
      expect(top.status).toBe(200);
      const topJson = (await top.json()) as {
        directories: { cwd: string; raw_command_count: number; filtered_command_count: number }[];
      };
      expect(topJson.directories[0]).toMatchObject({
        cwd: "/repo",
        raw_command_count: 2,
        filtered_command_count: 1,
      });

      const commands = await app.request(
        `http://x/api/atuin/directories/commands?cwd=${encodeURIComponent("/repo")}`
      );
      expect(commands.status).toBe(200);
      const commandsJson = (await commands.json()) as {
        commands: { command: string; filtered_count: number }[];
      };
      expect(commandsJson.commands.map((row) => [row.command, row.filtered_count])).toEqual([
        ["npm test", 1],
        ["git status", 0],
      ]);

      const badMode = await app.request("http://x/api/atuin/directories/top?mode=nope");
      expect(badMode.status).toBe(400);
      const badLimit = await app.request("http://x/api/atuin/directories/search?q=repo&limit=0");
      expect(badLimit.status).toBe(400);
    } finally {
      source.close();
      index.close();
    }
  });
});
