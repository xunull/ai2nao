import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { upsertStar, upsertRepo } from "../src/github/queries.js";
import {
  listTagAliases,
  rebuildAllRepoTags,
  rebuildRepoTagsForIds,
  removeAlias,
  seedTagAliases,
  upsertUserAlias,
} from "../src/github/tags.js";
import type { GithubApiRepo, GithubApiStar } from "../src/github/fetcher.js";

/**
 * Exercises the gh_repo_tag rebuild path end-to-end: alias map application,
 * language-fallback insertion, and the `rebuildRepoTagsForIds` variant that
 * incremental sync uses. These are the queries the whole feature rests on,
 * so they need real SQL (no mocks).
 */

function freshDb() {
  const path = join(
    tmpdir(),
    `ai2nao-tags-rebuild-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  return openDatabase(path);
}

function repoFixture(partial: Partial<GithubApiRepo> = {}): GithubApiRepo {
  return {
    id: 1,
    name: "demo",
    full_name: "alice/demo",
    owner: { login: "alice" },
    description: null,
    private: false,
    fork: false,
    archived: false,
    default_branch: "main",
    html_url: "https://github.com/alice/demo",
    clone_url: "https://github.com/alice/demo.git",
    language: "TypeScript",
    topics: [],
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    size: 0,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    pushed_at: "2024-01-01T00:00:00Z",
    ...partial,
  };
}

function starFixture(
  id: number,
  topics: string[],
  opts: { starredAt?: string; language?: string | null } = {}
): GithubApiStar {
  return {
    starred_at: opts.starredAt ?? "2024-03-01T00:00:00Z",
    repo: repoFixture({
      id,
      name: `r${id}`,
      full_name: `u/r${id}`,
      topics,
      language: opts.language === undefined ? "Python" : opts.language,
    }),
  };
}

function queryTags(
  db: Database.Database,
  repoId: number
): Array<{ tag: string; source: string }> {
  return db
    .prepare(
      "SELECT tag, source FROM gh_repo_tag WHERE repo_id = ? ORDER BY tag"
    )
    .all(repoId) as Array<{ tag: string; source: string }>;
}

describe("seedTagAliases + alias CRUD", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it("is idempotent and preserves user overrides on re-seed", () => {
    const first = seedTagAliases(db);
    expect(first).toBeGreaterThan(0);
    const second = seedTagAliases(db);
    expect(second).toBe(0);

    // User override on a preset from_tag must win (preset uses INSERT OR IGNORE).
    upsertUserAlias(db, "js", "javascript-my-way", "personal override");
    const third = seedTagAliases(db);
    expect(third).toBe(0);
    const jsRow = listTagAliases(db).find((r) => r.from_tag === "js");
    expect(jsRow?.to_tag).toBe("javascript-my-way");
    expect(jsRow?.source).toBe("user");

    expect(removeAlias(db, "js")).toBe(true);
    expect(removeAlias(db, "js")).toBe(false);
  });

  it("filters listTagAliases by source", () => {
    seedTagAliases(db);
    upsertUserAlias(db, "foo", "bar", null);
    const all = listTagAliases(db);
    const presets = listTagAliases(db, "preset");
    const users = listTagAliases(db, "user");
    expect(presets.length + users.length).toBe(all.length);
    expect(users.map((r) => r.from_tag)).toContain("foo");
    expect(presets.every((r) => r.source === "preset")).toBe(true);
  });
});

describe("rebuildAllRepoTags", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    // Seed a tiny alias map focused on the cases we assert — avoid coupling
    // to the ~50 preset entries, which may legitimately change over time.
    upsertUserAlias(db, "js", "javascript", null);
    upsertUserAlias(db, "ts", "typescript", null);
  });
  afterEach(() => db.close());

  it("maps raw topics through alias table and writes canonical tags", () => {
    upsertStar(db, starFixture(1, ["js", "ML"]), "2024-03-01T00:00:00Z");
    upsertStar(db, starFixture(2, ["ts", "agent"]), "2024-03-02T00:00:00Z");

    const stats = rebuildAllRepoTags(db);
    expect(stats.starsScanned).toBe(2);
    expect(stats.reposWithNoTags).toBe(0);

    expect(queryTags(db, 1)).toEqual([
      { tag: "javascript", source: "topic" },
      { tag: "ml", source: "topic" },
    ]);
    expect(queryTags(db, 2)).toEqual([
      { tag: "agent", source: "topic" },
      { tag: "typescript", source: "topic" },
    ]);
  });

  it("falls back to language:* when a star has no topics", () => {
    upsertStar(db, starFixture(10, [], { language: "Go" }), "2024-03-01T00:00:00Z");
    upsertStar(db, starFixture(11, [], { language: null }), "2024-03-02T00:00:00Z");

    const stats = rebuildAllRepoTags(db);
    expect(stats.starsScanned).toBe(2);

    expect(queryTags(db, 10)).toEqual([
      { tag: "language:go", source: "language-fallback" },
    ]);
    // Null language with no topics produces no tag row — counted as "no tags".
    expect(queryTags(db, 11)).toEqual([]);
    expect(stats.reposWithNoTags).toBe(1);
  });

  it("is fully regenerative — removing aliases and rebuilding clears old mappings", () => {
    upsertStar(db, starFixture(1, ["js"]), "2024-03-01T00:00:00Z");
    rebuildAllRepoTags(db);
    expect(queryTags(db, 1)).toEqual([
      { tag: "javascript", source: "topic" },
    ]);

    removeAlias(db, "js");
    rebuildAllRepoTags(db);
    // Without the alias, "js" is its own canonical tag.
    expect(queryTags(db, 1)).toEqual([{ tag: "js", source: "topic" }]);
  });
});

describe("rebuildRepoTagsForIds", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    upsertUserAlias(db, "js", "javascript", null);
    upsertStar(db, starFixture(1, ["js"]), "2024-03-01T00:00:00Z");
    upsertStar(db, starFixture(2, ["ml"]), "2024-03-02T00:00:00Z");
    rebuildAllRepoTags(db);
  });
  afterEach(() => db.close());

  it("only touches the specified repo_ids", () => {
    // Simulate the user adding a new alias after the initial sync, then
    // only touching one repo.
    upsertUserAlias(db, "ml", "machine-learning", null);

    const stats = rebuildRepoTagsForIds(db, [2]);
    expect(stats.starsScanned).toBe(1);
    expect(stats.tagsInserted).toBe(1);

    // repo 1 keeps its pre-existing tag row untouched.
    expect(queryTags(db, 1)).toEqual([
      { tag: "javascript", source: "topic" },
    ]);
    // repo 2 now reflects the new alias.
    expect(queryTags(db, 2)).toEqual([
      { tag: "machine-learning", source: "topic" },
    ]);
  });

  it("clears tag rows for a repo whose topics changed to empty + null language", () => {
    // Replace star 1 with a version that has no topics and null language.
    upsertStar(
      db,
      starFixture(1, [], { language: null, starredAt: "2024-03-05T00:00:00Z" }),
      "2024-03-05T00:00:00Z"
    );
    rebuildRepoTagsForIds(db, [1]);
    expect(queryTags(db, 1)).toEqual([]);
  });

  it("no-op for empty id iterable and for ids that don't exist in gh_star", () => {
    const empty = rebuildRepoTagsForIds(db, []);
    expect(empty.starsScanned).toBe(0);
    expect(empty.tagsInserted).toBe(0);

    const missing = rebuildRepoTagsForIds(db, [999]);
    expect(missing.starsScanned).toBe(0);
    // repo 1 + 2 tags are untouched.
    expect(queryTags(db, 1)).toEqual([{ tag: "javascript", source: "topic" }]);
  });
});

// Suppress unused-import warning for upsertRepo (kept for parity with future tests).
void upsertRepo;
