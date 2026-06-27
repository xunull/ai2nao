import { describe, expect, it } from "vitest";
import { projectOutputAnalysis } from "../src/gitChurn/analysis.js";

const churn = (added: number, deleted: number, commits: number) => ({
  added,
  deleted,
  commits,
});

describe("projectOutputAnalysis", () => {
  it("joins token to repo by exact path and computes token/line = token/added", () => {
    const res = projectOutputAnalysis({
      tokens: new Map([["/r/app", 1000]]),
      repos: ["/r/app"],
      churn: new Map([["/r/app", churn(100, 10, 5)]]),
      scannedRepos: new Set(["/r/app"]),
    });
    expect(res.rows).toEqual([
      {
        repo: "/r/app",
        tokens: 1000,
        added: 100,
        deleted: 10,
        net: 90,
        commits: 5,
        tokensPerLine: 10, // 1000/100
        status: "ok",
      },
    ]);
    expect(res.unmatched).toEqual({
      nonPathIdentity: [],
      noMatchingRepo: [],
      gitNoToken: [],
    });
  });

  it("maps a subdir token project up to its containing repo (longest prefix) and sums tokens", () => {
    const res = projectOutputAnalysis({
      tokens: new Map([
        ["/r/app", 600], // repo root
        ["/r/app/packages/web", 400], // subdir -> same repo
        ["/r/app/packages", 0],
      ]),
      repos: ["/r/app", "/r/other"],
      churn: new Map([["/r/app", churn(50, 0, 2)]]),
      scannedRepos: new Set(["/r/app", "/r/other"]),
    });
    const row = res.rows.find((r) => r.repo === "/r/app")!;
    expect(row.tokens).toBe(1000); // 600 + 400 + 0 aggregated up to repo
    expect(row.tokensPerLine).toBe(20); // 1000/50
  });

  it("buckets a non-path project_key as nonPathIdentity (never silently dropped)", () => {
    const res = projectOutputAnalysis({
      tokens: new Map([["claude-code:abcd", 500]]),
      repos: ["/r/app"],
      churn: new Map(),
      scannedRepos: new Set(["/r/app"]),
    });
    expect(res.rows).toHaveLength(0);
    expect(res.unmatched.nonPathIdentity).toEqual([
      { key: "claude-code:abcd", tokens: 500 },
    ]);
  });

  it("buckets a path key with no containing repo as noMatchingRepo", () => {
    const res = projectOutputAnalysis({
      tokens: new Map([["/somewhere/else", 300]]),
      repos: ["/r/app"],
      churn: new Map(),
      scannedRepos: new Set(["/r/app"]),
    });
    expect(res.unmatched.noMatchingRepo).toEqual([
      { key: "/somewhere/else", tokens: 300 },
    ]);
  });

  it("flags not_scanned when the repo has tokens but no churn row and was never scanned", () => {
    const res = projectOutputAnalysis({
      tokens: new Map([["/r/app", 1000]]),
      repos: ["/r/app"],
      churn: new Map(), // no churn synced
      scannedRepos: new Set(), // scheduler never ran
    });
    const row = res.rows.find((r) => r.repo === "/r/app")!;
    expect(row.status).toBe("not_scanned");
    expect(row.tokensPerLine).toBeNull(); // no added -> no ratio
  });

  it("token/line is null when added is 0 (pure-delete or denoised-only)", () => {
    const res = projectOutputAnalysis({
      tokens: new Map([["/r/app", 1000]]),
      repos: ["/r/app"],
      churn: new Map([["/r/app", churn(0, 40, 3)]]),
      scannedRepos: new Set(["/r/app"]),
    });
    expect(res.rows[0].tokensPerLine).toBeNull();
  });

  it("lists repos that have churn but no token as gitNoToken", () => {
    const res = projectOutputAnalysis({
      tokens: new Map(),
      repos: ["/r/app"],
      churn: new Map([["/r/app", churn(20, 5, 1)]]),
      scannedRepos: new Set(["/r/app"]),
    });
    expect(res.rows).toHaveLength(0);
    expect(res.unmatched.gitNoToken).toEqual([
      { repo: "/r/app", added: 20, deleted: 5, commits: 1 },
    ]);
  });
});
