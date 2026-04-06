import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { discoverGitRepos } from "../src/scanner/discover.js";
import { parseOriginUrlFromGitConfig } from "../src/git/parseConfig.js";
import { openDatabase } from "../src/store/open.js";
import { runScan } from "../src/scan/runScan.js";
import { searchManifests } from "../src/store/operations.js";

describe("parseOriginUrlFromGitConfig", () => {
  it("reads origin url", () => {
    const cfg = `
[remote "origin"]
  url = git@github.com:foo/bar.git
[remote "other"]
  url = https://example.com/x.git
`;
    expect(parseOriginUrlFromGitConfig(cfg)).toBe("git@github.com:foo/bar.git");
  });
});

describe("discover + scan + search", () => {
  it("indexes package.json and finds tokens via FTS", () => {
    const base = join(tmpdir(), `ai2nao-test-${Date.now()}`);
    const repo = join(base, "proj");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(
      join(repo, ".git", "config"),
      '[remote "origin"]\n\turl = https://example.com/a/b.git\n',
      "utf8"
    );
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "fixture-pkg", version: "1.0.0" }),
      "utf8"
    );

    const found = discoverGitRepos(base);
    expect(found).toHaveLength(1);
    expect(found[0].originUrl).toContain("example.com");

    const dbPath = join(base, "idx.db");
    const db = openDatabase(dbPath);
    try {
      const result = runScan(db, [base], ["package.json"]);
      expect(result.reposFound).toBe(1);
      expect(result.manifestsIndexed).toBe(1);
      const hits = searchManifests(db, "fixture", 10);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].rel_path).toBe("package.json");
    } finally {
      db.close();
    }
  });
});
