import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverGitRepos } from "../src/scanner/discover.js";

let base: string;

function gitRepoAt(rel: string): string {
  const dir = join(base, rel);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
  return dir;
}

const names = (maxDepth?: number) =>
  discoverGitRepos(base, maxDepth === undefined ? undefined : { maxDepth })
    .map((r) => basename(r.rootCanonical))
    .sort();

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ai2nao-depth-"));
  gitRepoAt("shallow"); // base/shallow/.git  -> depth 1
  gitRepoAt("x/y/deep"); // base/x/y/deep/.git -> depth 3
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("discoverGitRepos maxDepth", () => {
  it("unlimited (undefined) finds repos at any depth", () => {
    expect(names(undefined)).toEqual(["deep", "shallow"]);
  });

  it("maxDepth 1 finds only the shallow repo", () => {
    expect(names(1)).toEqual(["shallow"]);
  });

  it("maxDepth 3 reaches the deep repo too", () => {
    expect(names(3)).toEqual(["deep", "shallow"]);
  });

  it("maxDepth 0 descends nowhere (root itself has no .git)", () => {
    expect(names(0)).toEqual([]);
  });
});
