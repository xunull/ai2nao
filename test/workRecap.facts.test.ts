import { describe, expect, it } from "vitest";
import { computeFacts, isSparseFacts } from "../src/workRecap/facts.js";
import type { WorkRecapCommit } from "../src/workRecap/types.js";

function commit(
  repoPath: string,
  repoLabel: string,
  sha: string,
  date: string,
  subject: string,
  kind: WorkRecapCommit["kind"] = "other"
): WorkRecapCommit {
  return {
    repoPath,
    repoLabel,
    sha,
    authorEmail: "me@example.com",
    authorName: "Me",
    committedAt: new Date(date),
    subject,
    kind,
  };
}

const WINDOW_START = new Date("2026-06-01T00:00:00Z");
const WINDOW_END = new Date("2026-06-07T00:00:00Z");

describe("computeFacts", () => {
  it("returns zeroed facts for empty commits", () => {
    const f = computeFacts({
      commits: [],
      windowKey: "7d",
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      authorEmail: "me@example.com",
      reposScanned: 0,
      reposTotal: 0,
      scanTruncated: false,
      scanTruncatedReason: null,
      scanDiagnostics: [],
    });
    expect(f.totalCommits).toBe(0);
    expect(f.projectCount).toBe(0);
    expect(f.projectShare).toHaveLength(0);
    expect(Object.values(f.commitTypeCounts).every((n) => n === 0)).toBe(true);
    expect(f.dailyCounts.length).toBeGreaterThan(0); // every day in window gets a bucket
    expect(f.dailyCounts.every((d) => d.commitCount === 0)).toBe(true);
  });

  it("computes projectShare sorted by commitCount, share 0..1", () => {
    const commits = [
      commit("/a", "alpha", "s1", "2026-06-02T10:00:00Z", "feat: a1", "feat"),
      commit("/a", "alpha", "s2", "2026-06-02T11:00:00Z", "fix: a2", "fix"),
      commit("/a", "alpha", "s3", "2026-06-03T10:00:00Z", "feat: a3", "feat"),
      commit("/b", "bravo", "s4", "2026-06-02T10:00:00Z", "docs: b1", "docs"),
    ];
    const f = computeFacts({
      commits,
      windowKey: "7d",
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      authorEmail: "me@example.com",
      reposScanned: 2,
      reposTotal: 2,
      scanTruncated: false,
      scanTruncatedReason: null,
      scanDiagnostics: [],
    });
    expect(f.totalCommits).toBe(4);
    expect(f.projectCount).toBe(2);
    expect(f.projectShare[0].projectKey).toBe("/a");
    expect(f.projectShare[0].commitCount).toBe(3);
    expect(f.projectShare[0].share).toBeCloseTo(0.75);
    expect(f.projectShare[1].projectKey).toBe("/b");
    expect(f.projectShare[1].share).toBeCloseTo(0.25);
  });

  it("counts commitTypeCounts by kind", () => {
    const commits = [
      commit("/a", "alpha", "s1", "2026-06-02T10:00:00Z", "feat: a", "feat"),
      commit("/a", "alpha", "s2", "2026-06-02T11:00:00Z", "feat: b", "feat"),
      commit("/a", "alpha", "s3", "2026-06-03T10:00:00Z", "fix: c", "fix"),
      commit("/a", "alpha", "s4", "2026-06-04T10:00:00Z", "chore: d", "chore"),
    ];
    const f = computeFacts({
      commits,
      windowKey: "7d",
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      authorEmail: "me@example.com",
      reposScanned: 1,
      reposTotal: 1,
      scanTruncated: false,
      scanTruncatedReason: null,
      scanDiagnostics: [],
    });
    expect(f.commitTypeCounts.feat).toBe(2);
    expect(f.commitTypeCounts.fix).toBe(1);
    expect(f.commitTypeCounts.chore).toBe(1);
    expect(f.commitTypeCounts.docs).toBe(0);
  });

  it("buckets dailyCounts in local time, zero-fills empty days", () => {
    const commits = [
      commit("/a", "alpha", "s1", "2026-06-02T10:00:00Z", "feat: a", "feat"),
      commit("/a", "alpha", "s2", "2026-06-02T20:00:00Z", "fix: b", "fix"),
      commit("/a", "alpha", "s3", "2026-06-04T10:00:00Z", "feat: c", "feat"),
    ];
    const f = computeFacts({
      commits,
      windowKey: "7d",
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      authorEmail: "me@example.com",
      reposScanned: 1,
      reposTotal: 1,
      scanTruncated: false,
      scanTruncatedReason: null,
      scanDiagnostics: [],
    });
    // dailyCounts contains contiguous days
    const dates = f.dailyCounts.map((b) => b.date);
    expect(dates.length).toBeGreaterThanOrEqual(6);
    const totalFromBuckets = f.dailyCounts.reduce(
      (sum, b) => sum + b.commitCount,
      0
    );
    expect(totalFromBuckets).toBe(3);
  });

  it("propagates scan truncation metadata", () => {
    const f = computeFacts({
      commits: [],
      windowKey: "7d",
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      authorEmail: "me@example.com",
      reposScanned: 5,
      reposTotal: 12,
      scanTruncated: true,
      scanTruncatedReason: "scan_timeout",
      scanDiagnostics: [
        { severity: "warning", kind: "scan_timeout", message: "..." },
      ],
    });
    expect(f.scanTruncated).toBe(true);
    expect(f.scanTruncatedReason).toBe("scan_timeout");
    expect(f.reposScanned).toBe(5);
    expect(f.reposTotal).toBe(12);
    expect(f.diagnostics).toHaveLength(1);
  });
});

describe("isSparseFacts", () => {
  it("treats <3 commits as sparse", () => {
    const f = computeFacts({
      commits: [
        commit("/a", "alpha", "s1", "2026-06-02T10:00:00Z", "feat: a", "feat"),
      ],
      windowKey: "7d",
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      authorEmail: "me@example.com",
      reposScanned: 1,
      reposTotal: 1,
      scanTruncated: false,
      scanTruncatedReason: null,
      scanDiagnostics: [],
    });
    expect(isSparseFacts(f)).toBe(true);
  });
});
