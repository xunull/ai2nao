import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { runScan } from "../src/scan/runScan.js";
import { canonicalizePath } from "../src/path/canonical.js";

let base: string;

function gitRepo(rel: string, opts?: { docs?: number }): void {
  const dir = join(base, rel);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
  writeFileSync(join(dir, "package.json"), `{"name":"${basename(rel)}"}`);
  if (opts?.docs) {
    mkdirSync(join(dir, "docs"), { recursive: true });
    for (let i = 0; i < opts.docs; i++) {
      writeFileSync(join(dir, "docs", `d${i}.md`), `# doc ${i}`);
    }
  }
}

const repoPaths = (db: Database.Database) => {
  const canonBase = canonicalizePath(base) ?? base; // realpath: macOS /var -> /private/var
  return (
    db.prepare("SELECT path_canonical FROM repos ORDER BY path_canonical").all() as {
      path_canonical: string;
    }[]
  ).map((r) => r.path_canonical.replace(canonBase, ""));
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ai2nao-par-"));
  // Two roots, nested repos, one repo with more docs than the cap (2).
  gitRepo("root1/repoA", { docs: 3 });
  gitRepo("root1/nested/deep/repoB");
  gitRepo("root2/repoC");
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("runScan parallel correctness", () => {
  it("finds repos across multiple roots and nested dirs", async () => {
    const db = openDatabase(join(base, "i.db"));
    const r = await runScan(db, [join(base, "root1"), join(base, "root2")], undefined, {
      maxDocs: 2,
      concurrency: 16,
    });
    expect(r.reposFound).toBe(3); // A (root1), B (nested), C (root2)
    expect(repoPaths(db).sort()).toEqual([
      "/root1/nested/deep/repoB",
      "/root1/repoA",
      "/root2/repoC",
    ]);
    db.close();
  });

  it("produces identical results at concurrency 1 and 16 (deterministic)", async () => {
    const roots = [join(base, "root1"), join(base, "root2")];

    const db1 = openDatabase(join(base, "c1.db"));
    const seq = await runScan(db1, roots, undefined, { maxDocs: 2, concurrency: 1 });
    const paths1 = repoPaths(db1);
    db1.close();

    const db16 = openDatabase(join(base, "c16.db"));
    const par = await runScan(db16, roots, undefined, { maxDocs: 2, concurrency: 16 });
    const paths16 = repoPaths(db16);
    db16.close();

    expect(par.reposFound).toBe(seq.reposFound);
    expect(par.manifestsIndexed).toBe(seq.manifestsIndexed);
    expect(par.cappedDocs).toBe(seq.cappedDocs);
    expect(seq.cappedDocs).toBe(1); // repoA has 3 docs, cap 2 -> 1 capped
    expect(paths16.sort()).toEqual(paths1.sort());
    expect(par.errors).toEqual([]);
  });

  it("dedups a repo reachable from two overlapping roots", async () => {
    const db = openDatabase(join(base, "dedup.db"));
    // root1 and root1/nested both contain repoB's subtree; scanning both must not
    // double-count repoB.
    const r = await runScan(db, [join(base, "root1"), join(base, "root1/nested")], undefined, {
      concurrency: 8,
    });
    expect(r.reposFound).toBe(2); // repoA + repoB, each once
    db.close();
  });
});
