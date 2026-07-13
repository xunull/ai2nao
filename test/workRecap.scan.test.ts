import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyCommitKind,
  scanCommits,
  scanSingleRepo,
} from "../src/workRecap/scan.js";

const TEST_EMAIL = "scan-tester@example.com";

function makeRepo(commits: { msg: string; date: string; email?: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-scan-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Scan Tester"], { cwd: dir });
  execFileSync("git", ["config", "user.email", TEST_EMAIL], { cwd: dir });
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    writeFileSync(join(dir, `f${i}.txt`), `content ${i}\n`);
    execFileSync("git", ["add", "."], { cwd: dir });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_COMMITTER_DATE: c.date,
      GIT_AUTHOR_DATE: c.date,
    };
    if (c.email) {
      env.GIT_AUTHOR_EMAIL = c.email;
      env.GIT_COMMITTER_EMAIL = c.email;
    }
    execFileSync("git", ["commit", "-q", "-m", c.msg], { cwd: dir, env });
  }
  return dir;
}

/**
 * `--until` guards the calendar windows (today / last-week). Without it a
 * `last-week` recap would log through *now* and silently swallow this week.
 */
describe("scanSingleRepo --until (calendar-window upper bound)", () => {
  it("excludes commits after the window end, keeps the ones inside", async () => {
    const dir = makeRepo([
      { msg: "feat: before window", date: "2026-07-01T10:00:00Z" },
      { msg: "feat: inside window", date: "2026-07-08T10:00:00Z" },
      { msg: "feat: after window", date: "2026-07-14T10:00:00Z" },
    ]);
    const { commits } = await scanSingleRepo({
      cwd: dir,
      authorEmail: TEST_EMAIL,
      since: new Date("2026-07-06T00:00:00Z"), // 上周一
      until: new Date("2026-07-13T00:00:00Z"), // 本周一(排他上界)
    });
    const subjects = commits.map((c) => c.subject);
    expect(subjects).toEqual(["feat: inside window"]);
    expect(subjects).not.toContain("feat: after window");
    expect(subjects).not.toContain("feat: before window");
  });

  it("without --until, the window end is ignored (regression guard for the bug it fixes)", async () => {
    const dir = makeRepo([
      { msg: "feat: inside window", date: "2026-07-08T10:00:00Z" },
      { msg: "feat: after window", date: "2026-07-14T10:00:00Z" },
    ]);
    const { commits } = await scanSingleRepo({
      cwd: dir,
      authorEmail: TEST_EMAIL,
      since: new Date("2026-07-06T00:00:00Z"),
      // no until → git logs through HEAD, so "after window" leaks in
    });
    expect(commits.map((c) => c.subject)).toContain("feat: after window");
  });

  it("--max-count takes NEWEST first, so without --until a busy repo drops the window entirely", async () => {
    // 3 commits after the window + 1 inside. With maxCount=2 and no --until,
    // git returns the 2 newest — both out of window — and last week vanishes.
    const commitsSpec = [
      { msg: "feat: inside window", date: "2026-07-08T10:00:00Z" },
      { msg: "chore: after 1", date: "2026-07-14T10:00:00Z" },
      { msg: "chore: after 2", date: "2026-07-15T10:00:00Z" },
      { msg: "chore: after 3", date: "2026-07-16T10:00:00Z" },
    ];
    const since = new Date("2026-07-06T00:00:00Z");
    const until = new Date("2026-07-13T00:00:00Z");

    const dirA = makeRepo(commitsSpec);
    const bad = await scanSingleRepo({
      cwd: dirA,
      authorEmail: TEST_EMAIL,
      since,
      maxCount: 2, // no until → cap eaten by out-of-window commits
    });
    expect(bad.commits.map((c) => c.subject)).not.toContain("feat: inside window");

    const dirB = makeRepo(commitsSpec);
    const good = await scanSingleRepo({
      cwd: dirB,
      authorEmail: TEST_EMAIL,
      since,
      until, // with until → the cap only ever sees in-window commits
      maxCount: 2,
    });
    expect(good.commits.map((c) => c.subject)).toEqual(["feat: inside window"]);
  });
});

describe("classifyCommitKind", () => {
  it("classifies conventional-commit prefixes", () => {
    expect(classifyCommitKind("feat: add login")).toBe("feat");
    expect(classifyCommitKind("fix(auth): handle null")).toBe("fix");
    expect(classifyCommitKind("Refactor!: rename")).toBe("refactor");
    expect(classifyCommitKind("docs: README tweak")).toBe("docs");
    expect(classifyCommitKind("chore: bump deps")).toBe("chore");
    expect(classifyCommitKind("test: new spec")).toBe("test");
    expect(classifyCommitKind("style: format")).toBe("style");
    expect(classifyCommitKind("perf: cache")).toBe("perf");
    expect(classifyCommitKind("build: docker")).toBe("build");
    expect(classifyCommitKind("ci: github actions")).toBe("ci");
    expect(classifyCommitKind('revert: "feat: x"')).toBe("revert");
    expect(classifyCommitKind("Revert previous PR")).toBe("revert");
    expect(classifyCommitKind("just a message")).toBe("other");
  });
});

describe("scanSingleRepo", () => {
  let repo: string;
  beforeAll(() => {
    repo = makeRepo([
      { msg: "feat: A", date: "2026-06-01T10:00:00Z" },
      { msg: "fix: B", date: "2026-06-02T10:00:00Z" },
      {
        msg: "chore: not me",
        date: "2026-06-03T10:00:00Z",
        email: "someone-else@example.com",
      },
      { msg: "feat: D", date: "2026-06-04T10:00:00Z" },
    ]);
  });

  it("filters by --author and returns parsed commits", async () => {
    const { commits } = await scanSingleRepo({
      cwd: repo,
      authorEmail: TEST_EMAIL,
      since: new Date("2026-05-01T00:00:00Z"),
    });
    expect(commits).toHaveLength(3);
    const subjects = commits.map((c) => c.subject).sort();
    expect(subjects).toEqual(["feat: A", "feat: D", "fix: B"]);
    for (const c of commits) {
      expect(c.authorEmail).toBe(TEST_EMAIL);
      expect(c.repoPath).toBe(repo);
    }
  });

  it("respects --since boundary", async () => {
    const { commits } = await scanSingleRepo({
      cwd: repo,
      authorEmail: TEST_EMAIL,
      since: new Date("2026-06-03T00:00:00Z"),
    });
    expect(commits).toHaveLength(1);
    expect(commits[0].subject).toBe("feat: D");
  });

  it("returns capHit=true when maxCount is small enough to trim", async () => {
    const { commits, capHit } = await scanSingleRepo({
      cwd: repo,
      authorEmail: TEST_EMAIL,
      since: new Date("2026-05-01T00:00:00Z"),
      maxCount: 2,
    });
    expect(commits).toHaveLength(2);
    expect(capHit).toBe(true);
  });
});

describe("scanCommits (multi-repo, p-limit, partial)", () => {
  it("returns empty result for empty repoPaths", async () => {
    const r = await scanCommits({
      repoPaths: [],
      authorEmail: TEST_EMAIL,
      since: new Date(),
    });
    expect(r.commits).toHaveLength(0);
    expect(r.reposScanned).toBe(0);
    expect(r.reposTotal).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("captures per-repo errors without failing the batch", async () => {
    const good = makeRepo([{ msg: "feat: X", date: "2026-06-01T10:00:00Z" }]);
    const bad = mkdtempSync(join(tmpdir(), "ai2nao-bad-")); // not a git repo
    const r = await scanCommits({
      repoPaths: [good, bad],
      authorEmail: TEST_EMAIL,
      since: new Date("2026-05-01T00:00:00Z"),
    });
    expect(r.commits.length).toBeGreaterThan(0);
    expect(r.reposScanned).toBe(1);
    expect(r.reposTotal).toBe(2);
    const errKinds = r.diagnostics.map((d) => d.kind);
    expect(errKinds).toContain("git_log_failed");
  });

  it("F6 T-B1: truncates and marks scan_timeout when global timeout fires", async () => {
    // Force timeout by giving an aggressive 1ms budget across multiple repos.
    const repos = [
      makeRepo([{ msg: "feat: 1", date: "2026-06-01T10:00:00Z" }]),
      makeRepo([{ msg: "feat: 2", date: "2026-06-01T10:00:00Z" }]),
      makeRepo([{ msg: "feat: 3", date: "2026-06-01T10:00:00Z" }]),
    ];
    const r = await scanCommits({
      repoPaths: repos,
      authorEmail: TEST_EMAIL,
      since: new Date("2026-05-01T00:00:00Z"),
      timeoutMs: 1,
    });
    expect(r.truncated).toBe(true);
    expect(r.truncatedReason).toBe("scan_timeout");
    expect(r.reposScanned).toBeLessThanOrEqual(r.reposTotal);
    expect(r.diagnostics.some((d) => d.kind === "scan_timeout")).toBe(true);
  });
});
