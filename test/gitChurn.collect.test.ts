import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { collectRepoChurn } from "../src/gitChurn/collect.js";

const ME = "me@example.com";
const FLOOR = new Date("2026-01-01T00:00:00Z");

let base: string;
let repo: string;
let db: Database.Database;

function git(args: string[], env: Record<string, string> = {}) {
  execFileSync("git", args, {
    cwd: repo,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, ...env },
  });
}

/** APPEND `lines` to file `f` (so each commit is a pure +`lines` addition). */
let lineSeq = 0;
function commit(f: string, lines: number, email: string, isoDate: string) {
  const p = join(repo, f);
  const prev = existsSync(p) ? readFileSync(p, "utf8") : "";
  const add = Array.from({ length: lines }, () => `line ${lineSeq++}`).join("\n") + "\n";
  writeFileSync(p, prev + add);
  git(["add", f]);
  const env = {
    GIT_AUTHOR_NAME: email,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: email,
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
  };
  git(["commit", "-m", `add ${lines} to ${f}`], env);
}

function totals() {
  return db
    .prepare(
      "SELECT COALESCE(SUM(added),0) a, COALESCE(SUM(deleted),0) d, COALESCE(SUM(commits),0) c FROM git_line_churn WHERE project_key = ?"
    )
    .get(repo) as { a: number; d: number; c: number };
}

beforeEach(() => {
  base = join(tmpdir(), `ai2nao-churn-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q"]);
  git(["config", "user.email", ME]);
  git(["config", "user.name", "me"]);
  db = openDatabase(join(base, "idx.db"));
});

afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe("collectRepoChurn", () => {
  it("first run rescans and records the author's non-merge commits", async () => {
    commit("a.txt", 5, ME, "2026-06-20T12:00:00");
    commit("a.txt", 3, ME, "2026-06-20T13:00:00");

    const r = await collectRepoChurn(db, { repoPath: repo, authorEmail: ME, floorSince: FLOOR });
    expect(r.mode).toBe("rescan");

    const t = totals();
    expect(t.a).toBe(8); // 5 + 3
    expect(t.c).toBe(2);
    const state = db.prepare("SELECT last_synced_sha FROM git_line_churn_state WHERE repo_path=?").get(repo) as { last_synced_sha: string };
    expect(state.last_synced_sha).toHaveLength(40);
  });

  it("CRITICAL: incremental run accumulates new commits without re-counting old ones", async () => {
    commit("a.txt", 5, ME, "2026-06-20T12:00:00");
    commit("a.txt", 3, ME, "2026-06-20T13:00:00");
    await collectRepoChurn(db, { repoPath: repo, authorEmail: ME, floorSince: FLOOR }); // rescan

    commit("a.txt", 2, ME, "2026-06-21T10:00:00");
    const r = await collectRepoChurn(db, { repoPath: repo, authorEmail: ME, floorSince: FLOOR });
    expect(r.mode).toBe("incremental");

    const t = totals();
    expect(t.a).toBe(10); // 8 + 2, NOT 18 (old commits not re-added)
    expect(t.c).toBe(3);
  });

  it("CRITICAL: a forced rescan (rule_version change) replaces the window, never double-counts", async () => {
    commit("a.txt", 5, ME, "2026-06-20T12:00:00");
    commit("a.txt", 3, ME, "2026-06-20T13:00:00");
    await collectRepoChurn(db, { repoPath: repo, authorEmail: ME, floorSince: FLOOR, ruleVersion: 1 });
    expect(totals().a).toBe(8);

    // rule_version bump -> forced rescan; must DELETE-window-then-reinsert, not accumulate.
    const r = await collectRepoChurn(db, { repoPath: repo, authorEmail: ME, floorSince: FLOOR, ruleVersion: 2 });
    expect(r.mode).toBe("rescan");
    expect(totals().a).toBe(8); // still 8, NOT 16
    expect(totals().c).toBe(2);
  });

  it("filters by author — other authors' commits are not counted", async () => {
    commit("a.txt", 5, ME, "2026-06-20T12:00:00");
    commit("b.txt", 100, "someone@else.com", "2026-06-20T13:00:00");

    await collectRepoChurn(db, { repoPath: repo, authorEmail: ME, floorSince: FLOOR });
    const t = totals();
    expect(t.a).toBe(5); // only my commit
    expect(t.c).toBe(1);
  });

  it("denoises generated files (package-lock.json) out of the counts", async () => {
    commit("package-lock.json", 9999, ME, "2026-06-20T12:00:00");
    commit("src.ts", 4, ME, "2026-06-20T13:00:00");

    await collectRepoChurn(db, { repoPath: repo, authorEmail: ME, floorSince: FLOOR });
    const t = totals();
    expect(t.a).toBe(4); // lock file excluded
    expect(t.c).toBe(1); // the lock-only commit is not counted
  });
});
