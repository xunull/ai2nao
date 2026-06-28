import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { setScanRoots } from "../src/appConfig/index.js";
import { createDefaultScheduledTaskDefinitions } from "../src/scheduler/taskDefinitions.js";

let base: string;
let db: Database.Database;

const task = () => {
  const t = createDefaultScheduledTaskDefinitions().find((d) => d.key === "repos.scan");
  if (!t) throw new Error("repos.scan task not registered");
  return t;
};
const run = () => task().run({ db, config: {} });
const jobCount = () =>
  (db.prepare("SELECT COUNT(*) n FROM jobs").get() as { n: number }).n;
const repoCount = () =>
  (db.prepare("SELECT COUNT(*) n FROM repos").get() as { n: number }).n;

function storeRaw(roots: string[]) {
  db.prepare(
    "INSERT INTO app_config (key, value, updated_at) VALUES ('scan.roots', ?, 't') ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(JSON.stringify(roots));
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ai2nao-rst-"));
  db = openDatabase(join(base, "idx.db"));
});
afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe("repos.scan scheduler task", () => {
  it("is registered with the house defaults (disabled-by-default, daily, high sensitivity)", () => {
    const t = task();
    expect(t.category).toBe("local_inventory");
    expect(t.sensitivity).toBe("high");
    expect(t.defaultIntervalSeconds).toBe(24 * 60 * 60);
  });

  it("returns skipped when no roots are configured — no scan, no jobs row", async () => {
    const res = await run();
    expect(res.status).toBe("skipped");
    expect(jobCount()).toBe(0);
    expect(repoCount()).toBe(0);
  });

  it("returns failed when every configured root is invalid — no jobs row", async () => {
    storeRaw([join(base, "gone-a"), join(base, "gone-b")]);
    const res = await run();
    expect(res.status).toBe("failed");
    expect(res.errorSummary).toBeTruthy();
    expect(jobCount()).toBe(0);
  });

  it("scans the valid roots and indexes discovered git repos", async () => {
    const root = join(base, "code");
    const repo = join(root, "proj");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });
    writeFileSync(join(repo, "package.json"), '{"name":"proj"}');
    setScanRoots(db, [root]);

    const res = await run();
    expect(res.status).toBe("success");
    expect(repoCount()).toBe(1);
    expect(jobCount()).toBe(1); // runScan wrote exactly one job row
  });

  it("skips a deleted root but still scans the valid ones (partial-aware summary)", async () => {
    const root = join(base, "code");
    const repo = join(root, "proj");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });
    setScanRoots(db, [root]);
    storeRaw([root, join(base, "gone")]); // add a missing root alongside the valid one

    const res = await run();
    expect(["success", "partial"]).toContain(res.status);
    expect(repoCount()).toBe(1);
    expect((res.summary as { skipped: unknown[] }).skipped).toHaveLength(1);
  });
});
