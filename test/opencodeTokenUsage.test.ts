import BetterSqlite from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizePath } from "../src/path/canonical.js";
import {
  getOpencodeTokenUsageStatus,
  listOpencodeProjectTokenUsage,
} from "../src/opencodeTokenUsage/queries.js";

type SeedRow = {
  id: string;
  directory: string;
  tokensInput: number;
  tokensOutput: number;
  timeUpdated: number;
  timeArchived?: number | null;
};

let dataDir: string;
let dirA: string;
let dirB: string;

function key(dir: string): string {
  return canonicalizePath(dir, { bestEffort: true })!;
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

/** Build a temp opencode.db `session` table; omit token columns to simulate old schema. */
function seed(rows: SeedRow[], opts: { withTokenCols: boolean } = { withTokenCols: true }): void {
  const dbPath = join(dataDir, "opencode.db");
  const db = new BetterSqlite(dbPath);
  const tokenCols = opts.withTokenCols
    ? ", tokens_input INTEGER, tokens_output INTEGER"
    : "";
  db.exec(
    `CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      directory TEXT,
      title TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      time_archived INTEGER${tokenCols}
    )`
  );
  const cols = opts.withTokenCols
    ? "(id, project_id, directory, title, time_created, time_updated, time_archived, tokens_input, tokens_output)"
    : "(id, project_id, directory, title, time_created, time_updated, time_archived)";
  const placeholders = opts.withTokenCols
    ? "(?, ?, ?, ?, ?, ?, ?, ?, ?)"
    : "(?, ?, ?, ?, ?, ?, ?)";
  const stmt = db.prepare(`INSERT INTO session ${cols} VALUES ${placeholders}`);
  for (const r of rows) {
    const base = [
      r.id,
      "proj",
      r.directory,
      r.id,
      r.timeUpdated,
      r.timeUpdated,
      r.timeArchived ?? null,
    ];
    stmt.run(...(opts.withTokenCols ? [...base, r.tokensInput, r.tokensOutput] : base));
  }
  db.close();
}

describe("opencodeTokenUsage queries", () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "opencode-token-"));
    dirA = join(dataDir, "projA");
    dirB = join(dataDir, "projB");
    mkdirSync(dirA);
    mkdirSync(dirB);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("aggregates tokens by canonical directory and excludes archived sessions", () => {
    seed([
      { id: "s1", directory: dirA, tokensInput: 100, tokensOutput: 50, timeUpdated: ms("2026-06-10T00:00:00Z") },
      { id: "s2", directory: dirA, tokensInput: 10, tokensOutput: 5, timeUpdated: ms("2026-06-01T00:00:00Z") },
      { id: "s3", directory: dirB, tokensInput: 1000, tokensOutput: 500, timeUpdated: ms("2026-06-10T00:00:00Z") },
      { id: "s4", directory: dirA, tokensInput: 9999, tokensOutput: 9999, timeUpdated: ms("2026-06-10T00:00:00Z"), timeArchived: ms("2026-06-11T00:00:00Z") },
    ]);
    const usage = listOpencodeProjectTokenUsage(dataDir, {});
    const a = usage.get(key(dirA));
    expect(a).toMatchObject({
      projectKey: key(dirA),
      inputTokens: 110,
      outputTokens: 55,
      totalTokens: 165,
      totalSessions: 2,
      coveredSessions: 2,
      coverage: "full",
    });
    const b = usage.get(key(dirB));
    expect(b).toMatchObject({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, totalSessions: 1 });
    expect(usage.size).toBe(2);
  });

  it("applies the from filter on time_updated", () => {
    seed([
      { id: "s1", directory: dirA, tokensInput: 100, tokensOutput: 50, timeUpdated: ms("2026-06-10T00:00:00Z") },
      { id: "s2", directory: dirA, tokensInput: 10, tokensOutput: 5, timeUpdated: ms("2026-06-01T00:00:00Z") },
    ]);
    const usage = listOpencodeProjectTokenUsage(dataDir, { from: new Date("2026-06-05T00:00:00Z") });
    expect(usage.get(key(dirA))).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      totalSessions: 1,
    });
  });

  it("filters to requested projectKeys", () => {
    seed([
      { id: "s1", directory: dirA, tokensInput: 100, tokensOutput: 50, timeUpdated: ms("2026-06-10T00:00:00Z") },
      { id: "s3", directory: dirB, tokensInput: 1000, tokensOutput: 500, timeUpdated: ms("2026-06-10T00:00:00Z") },
    ]);
    const usage = listOpencodeProjectTokenUsage(dataDir, { projectKeys: [key(dirA)] });
    expect([...usage.keys()]).toEqual([key(dirA)]);
  });

  it("returns an empty map and a stale status when token columns are missing", () => {
    seed(
      [{ id: "s1", directory: dirA, tokensInput: 0, tokensOutput: 0, timeUpdated: ms("2026-06-10T00:00:00Z") }],
      { withTokenCols: false }
    );
    expect(listOpencodeProjectTokenUsage(dataDir, {}).size).toBe(0);
    const status = getOpencodeTokenUsageStatus(dataDir);
    expect(status.fresh).toBe(false);
    expect(status.staleReasons.join(" ")).toMatch(/token columns/i);
  });

  it("reports fresh status when token columns are present", () => {
    seed([{ id: "s1", directory: dirA, tokensInput: 1, tokensOutput: 1, timeUpdated: ms("2026-06-10T00:00:00Z") }]);
    expect(getOpencodeTokenUsageStatus(dataDir)).toEqual({ fresh: true, staleReasons: [] });
  });

  it("treats a missing opencode.db as empty usage + fresh (absent ≠ stale, no dashboard warning)", () => {
    expect(listOpencodeProjectTokenUsage(dataDir, {}).size).toBe(0);
    // 没装 opencode 是缺席不是 stale → fresh:true,看板不因此报 warning。
    expect(getOpencodeTokenUsageStatus(dataDir)).toEqual({ fresh: true, staleReasons: [] });
  });
});
