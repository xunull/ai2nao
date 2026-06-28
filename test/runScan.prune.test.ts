import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { runScan } from "../src/scan/runScan.js";
import { canonicalizePath } from "../src/path/canonical.js";

let base: string;
let db: Database.Database;

function gitRepo(abs: string): void {
  mkdirSync(abs, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: abs, stdio: ["ignore", "pipe", "ignore"] });
}

const missingOf = (canonPath: string): string | null => {
  const row = db
    .prepare("SELECT missing_since FROM repos WHERE path_canonical = ?")
    .get(canonPath) as { missing_since: string | null } | undefined;
  return row ? row.missing_since : "ROW_ABSENT";
};
const canon = (rel: string) => canonicalizePath(join(base, rel)) ?? join(base, rel);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ai2nao-prune-"));
  db = openDatabase(join(base, "idx.db"));
});
afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe("runScan prune (missing_since reconcile)", () => {
  it("marks a deleted repo missing, then clears it when it returns", async () => {
    gitRepo(join(base, "code/a"));
    gitRepo(join(base, "code/b"));
    await runScan(db, [join(base, "code")], undefined, { concurrency: 4 });
    expect(missingOf(canon("code/a"))).toBeNull();
    expect(missingOf(canon("code/b"))).toBeNull();

    // delete repo a, rescan -> a marked missing, b still present
    const aCanon = canon("code/a");
    rmSync(join(base, "code/a"), { recursive: true, force: true });
    await runScan(db, [join(base, "code")], undefined, { concurrency: 4 });
    expect(missingOf(aCanon)).toBeTruthy(); // a is gone
    expect(missingOf(canon("code/b"))).toBeNull();

    // a comes back -> missing_since cleared
    gitRepo(join(base, "code/a"));
    await runScan(db, [join(base, "code")], undefined, { concurrency: 4 });
    expect(missingOf(canon("code/a"))).toBeNull();
  });

  it("does NOT mark repos under a different (unscanned) root", async () => {
    gitRepo(join(base, "code/a"));
    gitRepo(join(base, "other/c"));
    await runScan(db, [join(base, "code"), join(base, "other")], undefined, { concurrency: 4 });
    // rescan ONLY code, delete nothing -> other/c must stay present (not in scope)
    await runScan(db, [join(base, "code")], undefined, { concurrency: 4 });
    expect(missingOf(canon("other/c"))).toBeNull();
  });

  it("nested guard: an inner repo inside a found repo is not marked missing", async () => {
    gitRepo(join(base, "code/outer"));
    // seed a stale row for a repo nested inside outer (scan stops at outer/.git,
    // so it is never re-found). It still 'exists' under outer -> must NOT be flagged.
    // Build under the canonical base so it is genuinely in-scope (tests the guard,
    // not a path-prefix mismatch).
    const canonBase = canonicalizePath(base)!;
    const innerCanon = join(canonBase, "code/outer/inner");
    db.prepare(
      `INSERT INTO repos (path_canonical, origin_url, first_seen_at, last_scanned_at, last_job_id)
       VALUES (?, NULL, 't', 't', NULL)`
    ).run(innerCanon);
    await runScan(db, [join(base, "code")], undefined, { concurrency: 4 });
    expect(missingOf(innerCanon)).toBeNull(); // nested -> guarded
  });

  it("handles a legacy row with NULL last_job_id (does not rely on last_job_id)", async () => {
    gitRepo(join(base, "code/a"));
    // a stale row whose dir does not exist, NULL last_job_id, under the scanned root
    // (built under the canonical base so it is in-scope — real rows are canonical).
    const goneCanon = join(canonicalizePath(base)!, "code", "ghost"); // dir never created
    db.prepare(
      `INSERT INTO repos (path_canonical, origin_url, first_seen_at, last_scanned_at, last_job_id)
       VALUES (?, NULL, 't', 't', NULL)`
    ).run(goneCanon);
    await runScan(db, [join(base, "code")], undefined, { concurrency: 4 });
    expect(missingOf(goneCanon)).toBeTruthy(); // legacy NULL row correctly marked
  });
});
