import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { upsertStar } from "../src/github/queries.js";
import {
  getTagTimeHeatmap,
  getTopTags,
  listTaggedRepos,
  rebuildAllRepoTags,
  upsertUserAlias,
} from "../src/github/tags.js";
import type { GithubApiRepo, GithubApiStar } from "../src/github/fetcher.js";

/**
 * Read-path queries: ranking, heatmap, and tag-intersection filtering.
 * Covers the AND vs OR divergence that is the most bug-prone branch.
 */

function freshDb() {
  const path = join(
    tmpdir(),
    `ai2nao-tags-q-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  return openDatabase(path);
}

function repoFixture(partial: Partial<GithubApiRepo>): GithubApiRepo {
  return {
    id: partial.id!,
    name: partial.name ?? `r${partial.id}`,
    full_name: partial.full_name ?? `u/r${partial.id}`,
    owner: { login: "u" },
    description: null,
    private: false,
    fork: false,
    archived: false,
    default_branch: "main",
    html_url: "https://example.com",
    clone_url: "https://example.com.git",
    language: partial.language ?? "Python",
    topics: partial.topics ?? [],
    stargazers_count: 1,
    forks_count: 0,
    open_issues_count: 0,
    size: 0,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    pushed_at: "2024-01-01T00:00:00Z",
    ...partial,
  };
}

function star(
  id: number,
  topics: string[],
  starredAt: string,
  language: string | null = "Python"
): GithubApiStar {
  return {
    starred_at: starredAt,
    repo: repoFixture({ id, topics, language: language ?? undefined }),
  };
}

function seedThreeRepos(db: Database.Database) {
  // Star 1: python + ml (recent)
  upsertStar(db, star(1, ["python", "ml"], "2024-06-01T00:00:00Z"), "2024-06-01T00:00:00Z");
  // Star 2: python + agent (older)
  upsertStar(db, star(2, ["python", "agent"], "2023-03-01T00:00:00Z"), "2023-03-01T00:00:00Z");
  // Star 3: rust (no python) + matching "ml"
  upsertStar(db, star(3, ["rust", "ml"], "2024-07-01T00:00:00Z"), "2024-07-01T00:00:00Z");
  // Star 4: no topics, language Go — should produce language:go fallback
  upsertStar(db, star(4, [], "2024-02-01T00:00:00Z", "Go"), "2024-02-01T00:00:00Z");
  rebuildAllRepoTags(db);
}

describe("getTopTags", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seedThreeRepos(db);
  });
  afterEach(() => db.close());

  it("defaults to topic-only; excludes language:* fallback", () => {
    const rows = getTopTags(db, { limit: 10 });
    const tags = rows.map((r) => r.tag);
    expect(tags).toContain("python");
    expect(tags).toContain("ml");
    expect(tags).not.toContain("language:go");
  });

  it("includes language:* fallback when opted in", () => {
    const rows = getTopTags(db, { limit: 10, includeLanguageFallback: true });
    expect(rows.map((r) => r.tag)).toContain("language:go");
  });

  it("window=12m excludes old stars", () => {
    // Freeze "now" at 2024-08-01 so the 12-month window is [2023-08-01, now).
    const rows = getTopTags(db, {
      window: "12m",
      now: () => new Date("2024-08-01T00:00:00Z"),
    });
    const tags = rows.map((r) => r.tag);
    expect(tags).toContain("ml");
    // Star 2 (agent, 2023-03) falls outside the 12-month window.
    expect(tags).not.toContain("agent");
  });

  it("sorts by count desc, then last_starred_at desc", () => {
    const rows = getTopTags(db);
    // "python" appears on 2 repos, "ml" on 2 repos — tied on count.
    // Tie-breaker is last_starred_at desc. "ml" last seen 2024-07, "python" 2024-06.
    const pythonIdx = rows.findIndex((r) => r.tag === "python");
    const mlIdx = rows.findIndex((r) => r.tag === "ml");
    expect(pythonIdx).toBeGreaterThanOrEqual(0);
    expect(mlIdx).toBeGreaterThanOrEqual(0);
    expect(mlIdx).toBeLessThan(pythonIdx);
  });
});

describe("getTagTimeHeatmap", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seedThreeRepos(db);
  });
  afterEach(() => db.close());

  it("computes month buckets for topic tags", () => {
    const result = getTagTimeHeatmap(db, { grain: "month" });
    expect(result.xs.length).toBeGreaterThan(0);
    // Sorted ascending.
    expect([...result.xs].sort()).toEqual(result.xs);
    // Each row's length matches xs length.
    for (const row of result.cells) {
      expect(row.length).toBe(result.xs.length);
    }
    // "ml" appears twice (2024-06 + 2024-07), "agent" once (2023-03).
    const mlRow = result.cells[result.ys.indexOf("ml")];
    const sumMl = mlRow.reduce((a, b) => a + b, 0);
    expect(sumMl).toBe(2);
  });

  it("respects explicit tags override", () => {
    const result = getTagTimeHeatmap(db, {
      tags: ["agent"],
      grain: "year",
    });
    expect(result.ys).toEqual(["agent"]);
    expect(result.xs).toEqual(["2023"]);
    expect(result.cells).toEqual([[1]]);
  });

  it("excludes language:* by default but includes when opted in", () => {
    const off = getTagTimeHeatmap(db, { grain: "month" });
    expect(off.ys).not.toContain("language:go");

    const on = getTagTimeHeatmap(db, {
      grain: "month",
      includeLanguageFallback: true,
    });
    expect(on.ys).toContain("language:go");
  });

  it("quarter grain bucketizes correctly", () => {
    const result = getTagTimeHeatmap(db, {
      grain: "quarter",
      tags: ["python"],
    });
    expect(result.xs).toEqual(["2023-Q1", "2024-Q2"]);
  });

  it("returns empty shape when no data in window", () => {
    const result = getTagTimeHeatmap(db, {
      from: "2030-01-01T00:00:00Z",
    });
    expect(result.xs).toEqual([]);
    expect(result.ys).toEqual([]);
    expect(result.cells).toEqual([]);
  });
});

describe("listTaggedRepos", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seedThreeRepos(db);
  });
  afterEach(() => db.close());

  it("OR union returns any repo matching any tag", () => {
    const result = listTaggedRepos(db, { tags: ["python", "rust"], mode: "or" });
    const ids = result.items.map((r) => r.repo_id).sort();
    expect(ids).toEqual([1, 2, 3]);
  });

  it("AND intersection requires every tag present on the same repo", () => {
    const result = listTaggedRepos(db, {
      tags: ["python", "ml"],
      mode: "and",
    });
    expect(result.items.map((r) => r.repo_id)).toEqual([1]);
  });

  it("attaches matched_tags subset per row", () => {
    const result = listTaggedRepos(db, {
      tags: ["python", "agent", "ml"],
      mode: "or",
    });
    const byId = new Map(result.items.map((r) => [r.repo_id, r.matched_tags.sort()]));
    expect(byId.get(1)).toEqual(["ml", "python"]);
    expect(byId.get(2)).toEqual(["agent", "python"]);
    expect(byId.get(3)).toEqual(["ml"]);
  });

  it("keyset cursor paginates by starred_at DESC", () => {
    const p1 = listTaggedRepos(db, {
      tags: ["python", "ml", "rust", "agent"],
      mode: "or",
      perPage: 2,
    });
    expect(p1.items.length).toBe(2);
    expect(p1.nextCursor).not.toBeNull();
    // Newest first — repo 3 (2024-07) then repo 1 (2024-06).
    expect(p1.items.map((r) => r.repo_id)).toEqual([3, 1]);

    const p2 = listTaggedRepos(db, {
      tags: ["python", "ml", "rust", "agent"],
      mode: "or",
      perPage: 2,
      cursor: p1.nextCursor,
    });
    expect(p2.items.map((r) => r.repo_id)).toEqual([2]);
    expect(p2.nextCursor).toBeNull();
  });

  it("empty tags short-circuits to empty list", () => {
    const result = listTaggedRepos(db, { tags: [], mode: "or" });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("honors from/to time filters", () => {
    const result = listTaggedRepos(db, {
      tags: ["python"],
      mode: "or",
      from: "2024-01-01T00:00:00Z",
    });
    expect(result.items.map((r) => r.repo_id)).toEqual([1]);
  });
});

// Silence the "unused" warning for alias helper used only in the rebuild test.
void upsertUserAlias;
