import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execGit, execGitSync } from "../src/git/exec.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-git-exec-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync(
    "git",
    ["commit", "-q", "-m", "feat: initial"],
    { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z" } }
  );
  return dir;
}

describe("execGitSync", () => {
  let repo: string;
  beforeAll(() => {
    repo = makeRepo();
  });

  it("returns stdout for a successful command", () => {
    const out = execGitSync(["log", "--oneline"], { cwd: repo });
    expect(out).toContain("feat: initial");
  });

  it("throws on non-zero exit (e.g. unknown subcommand)", () => {
    expect(() =>
      execGitSync(["this-is-not-a-real-git-subcommand"], { cwd: repo })
    ).toThrow();
  });
});

describe("execGit (async)", () => {
  let repo: string;
  beforeAll(() => {
    repo = makeRepo();
  });

  it("returns stdout for a successful command", async () => {
    const out = await execGit(["log", "--oneline"], { cwd: repo });
    expect(out).toContain("feat: initial");
  });

  it("rejects on non-zero exit", async () => {
    await expect(
      execGit(["this-is-not-a-real-git-subcommand"], { cwd: repo })
    ).rejects.toThrow();
  });

  it("rejects with AbortError when signal aborts mid-call", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      execGit(["log", "--oneline"], { cwd: repo, signal: controller.signal })
    ).rejects.toThrow();
  });
});
