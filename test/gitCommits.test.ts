process.env.TZ = "Asia/Shanghai"; // prove UTC conversion is tz-independent

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { ingestGitCommits } from "../src/gitCommits/ingest.js";
import { slugFromPath } from "../src/agentUserMessages/projectKey.js";

const ME = "me@example.com";
// Recent-enough dates so a bounded --since=180.days full scan always includes them.
const D1 = "2026-06-20T12:00:00+08:00"; // -> 2026-06-20T04:00:00.000Z
const D2 = "2026-06-21T09:00:00+08:00";
const D3 = "2026-06-22T09:00:00+08:00";

let base: string;
let db: Database.Database;

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, ...env },
  }).trim();
}

function initRepo(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", ME]);
  git(dir, ["config", "user.name", "me"]);
  return dir;
}

let lineSeq = 0;
/** Append `lines` lines to file `f` and commit as `email` at `isoDate`. */
function commit(
  repo: string,
  f: string,
  lines: number,
  email: string,
  isoDate: string,
  subject = `add ${lines} to ${f}`
) {
  const p = join(repo, f);
  const prev = existsSync(p) ? readFileSync(p, "utf8") : "";
  const add = Array.from({ length: lines }, () => `line ${lineSeq++}`).join("\n") + "\n";
  writeFileSync(p, prev + add);
  commitStaged(repo, f, email, isoDate, subject);
}

/** Commit a raw binary file (git numstat reports '-' '-'). */
function commitBinary(repo: string, f: string, email: string, isoDate: string) {
  writeFileSync(join(repo, f), Buffer.from([0, 1, 2, 0, 255, 0, 7, 8]));
  commitStaged(repo, f, email, isoDate, `add binary ${f}`);
}

function commitStaged(
  repo: string,
  f: string,
  email: string,
  isoDate: string,
  subject: string
) {
  git(repo, ["add", f]);
  git(repo, ["commit", "-m", subject], {
    GIT_AUTHOR_NAME: email,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: email,
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
  });
}

function seedRepoRow(path: string) {
  db.prepare(
    "INSERT INTO repos (path_canonical, first_seen_at) VALUES (?, ?)"
  ).run(path, "2026-01-01T00:00:00Z");
}

function rows(repoKey: string) {
  return db
    .prepare(
      `SELECT commit_hash AS hash, author_date_utc AS authorDateUtc,
              committer_date_utc AS committerDateUtc, subject, added, deleted,
              files_changed AS filesChanged, project_key AS projectKey
       FROM git_commits WHERE repo_key = ? ORDER BY author_date_utc, commit_hash`
    )
    .all(repoKey) as Array<{
    hash: string;
    authorDateUtc: string;
    committerDateUtc: string;
    subject: string;
    added: number;
    deleted: number;
    filesChanged: number;
    projectKey: string;
  }>;
}

function commitCount(repoKey: string): number {
  return (
    db.prepare("SELECT COUNT(*) c FROM git_commits WHERE repo_key = ?").get(repoKey) as {
      c: number;
    }
  ).c;
}

/** Non-merge commit hashes for ME, oldest-first (source of truth = git). */
function gitAuthorHashes(repo: string): string[] {
  const out = git(repo, ["log", "--no-merges", "--author=" + ME, "--reverse", "--format=%H"]);
  return out ? out.split("\n") : [];
}

beforeEach(() => {
  base = join(tmpdir(), `ai2nao-commits-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(base, { recursive: true });
  db = openDatabase(join(base, "idx.db"));
});

afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe("ingestGitCommits", () => {
  it("parses hash + author/committer ISO dates + subject + numstat totals", async () => {
    const repo = initRepo("normal");
    seedRepoRow(repo);
    commit(repo, "a.txt", 5, ME, D1, "feat: first");

    const res = await ingestGitCommits(db, { authorEmail: ME });
    expect(res.status).toBe("success");
    expect(res.reposScanned).toBe(1);
    expect(res.commitsUpserted).toBe(1);

    const r = rows(repo);
    expect(r).toHaveLength(1);
    expect(r[0].hash).toHaveLength(40);
    expect(r[0].authorDateUtc).toBe("2026-06-20T04:00:00.000Z"); // +08:00 -> UTC
    expect(r[0].committerDateUtc).toBe("2026-06-20T04:00:00.000Z");
    expect(r[0].subject).toBe("feat: first");
    expect(r[0].added).toBe(5);
    expect(r[0].deleted).toBe(0);
    expect(r[0].filesChanged).toBe(1);
  });

  it("--no-merges: a merge commit is excluded", async () => {
    const repo = initRepo("merges");
    seedRepoRow(repo);
    commit(repo, "a.txt", 2, ME, D1, "base"); // C1 on default branch
    const baseBranch = git(repo, ["branch", "--show-current"]);

    git(repo, ["checkout", "-q", "-b", "feature"]);
    commit(repo, "feat.txt", 3, ME, D2, "feature work"); // C2 on feature

    git(repo, ["checkout", "-q", baseBranch]);
    commit(repo, "a.txt", 1, ME, D2, "diverge"); // C3 on base -> forces a real merge

    // Merge commit authored by ME (two parents -> excluded by --no-merges).
    git(repo, ["merge", "--no-ff", "-m", "merge feature", "feature"], {
      GIT_AUTHOR_NAME: "me",
      GIT_AUTHOR_EMAIL: ME,
      GIT_COMMITTER_NAME: "me",
      GIT_COMMITTER_EMAIL: ME,
      GIT_AUTHOR_DATE: D3,
      GIT_COMMITTER_DATE: D3,
    });
    const mergeHash = git(repo, ["rev-parse", "HEAD"]);

    await ingestGitCommits(db, { authorEmail: ME });

    const hashes = rows(repo).map((r) => r.hash);
    expect(hashes).not.toContain(mergeHash); // merge excluded
    expect(hashes).toHaveLength(3); // C1, C2, C3
    expect(new Set(hashes)).toEqual(new Set(gitAuthorHashes(repo)));
  });

  it("--author filter: another author's commit is not collected", async () => {
    const repo = initRepo("authors");
    seedRepoRow(repo);
    commit(repo, "a.txt", 5, ME, D1, "mine");
    commit(repo, "b.txt", 100, "someone@else.com", D2, "theirs");

    await ingestGitCommits(db, { authorEmail: ME });

    const r = rows(repo);
    expect(r).toHaveLength(1);
    expect(r[0].subject).toBe("mine");
    expect(r[0].added).toBe(5);
  });

  it("binary numstat '-' counts as 0 added/deleted (still 1 file changed)", async () => {
    const repo = initRepo("binary");
    seedRepoRow(repo);
    commitBinary(repo, "blob.bin", ME, D1);

    await ingestGitCommits(db, { authorEmail: ME });

    const r = rows(repo);
    expect(r).toHaveLength(1);
    expect(r[0].added).toBe(0);
    expect(r[0].deleted).toBe(0);
    expect(r[0].filesChanged).toBe(1);
  });

  it("incremental: re-ingest adds only the new commit; state.lastHash == HEAD", async () => {
    const repo = initRepo("incremental");
    seedRepoRow(repo);
    commit(repo, "a.txt", 5, ME, D1, "first");
    commit(repo, "a.txt", 3, ME, D2, "second");

    await ingestGitCommits(db, { authorEmail: ME });
    expect(commitCount(repo)).toBe(2);

    commit(repo, "a.txt", 2, ME, D3, "third");
    const res = await ingestGitCommits(db, { authorEmail: ME });
    expect(res.commitsUpserted).toBe(1); // only the new commit
    expect(commitCount(repo)).toBe(3);

    const head = git(repo, ["rev-parse", "HEAD"]);
    const state = db
      .prepare("SELECT last_hash AS lastHash, last_status AS lastStatus FROM git_commits_state WHERE repo_key = ?")
      .get(repo) as { lastHash: string; lastStatus: string };
    expect(state.lastHash).toBe(head);
    expect(state.lastStatus).toBe("success");
  });

  it("rescan: an unreachable lastHash triggers a full rescan with no ghost/dup rows", async () => {
    const repo = initRepo("rescan");
    seedRepoRow(repo);
    commit(repo, "a.txt", 5, ME, D1, "first");
    commit(repo, "a.txt", 3, ME, D2, "second");

    await ingestGitCommits(db, { authorEmail: ME });
    const before = commitCount(repo);
    expect(before).toBe(2);

    // Corrupt the watermark to an unreachable hash -> incremental range fails.
    db.prepare("UPDATE git_commits_state SET last_hash = ? WHERE repo_key = ?").run(
      "0".repeat(40),
      repo
    );

    const res = await ingestGitCommits(db, { authorEmail: ME });
    expect(res.status).toBe("success");
    expect(commitCount(repo)).toBe(before); // stable: no ghost / no duplicate rows
    expect(new Set(rows(repo).map((r) => r.hash))).toEqual(new Set(gitAuthorHashes(repo)));
  });

  it("materializes project_key = slugFromPath(repoKey)", async () => {
    const repo = initRepo("projectkey");
    seedRepoRow(repo);
    commit(repo, "a.txt", 4, ME, D1, "first");

    await ingestGitCommits(db, { authorEmail: ME });

    const expected = slugFromPath(repo);
    expect(expected).not.toBeNull();
    for (const r of rows(repo)) expect(r.projectKey).toBe(expected);
  });

  it("non-git dir is error-isolated: ingest does not throw, good repo still ingested", async () => {
    const good = initRepo("good");
    const notGit = join(base, "not-a-repo");
    mkdirSync(notGit, { recursive: true });
    seedRepoRow(good);
    seedRepoRow(notGit);
    commit(good, "a.txt", 3, ME, D1, "ok");

    const res = await ingestGitCommits(db, { authorEmail: ME });
    expect(res.status).toBe("partial"); // one ok, one failed
    expect(res.reposScanned).toBe(1);
    expect(res.errors).toHaveLength(1);

    expect(commitCount(good)).toBe(1); // good repo unaffected
    expect(commitCount(notGit)).toBe(0);

    const state = db
      .prepare("SELECT last_status AS lastStatus FROM git_commits_state WHERE repo_key = ?")
      .get(notGit) as { lastStatus: string };
    expect(state.lastStatus).toBe("failed");
  });
});
