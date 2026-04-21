import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/store/open.js";
import {
  countRepos,
  countStars,
  getHeatmapBuckets,
  getMaxRepoUpdatedAt,
  getMaxStarredAt,
  getSyncState,
  listRepoIdsNeedingCommitCount,
  listRepos,
  listStars,
  parseTopicsSafe,
  setSyncStateValue,
  upsertCommitCount,
  upsertRepo,
  upsertStar,
} from "../src/github/queries.js";
import type { GithubApiRepo, GithubApiStar } from "../src/github/fetcher.js";

/** Fresh migrated DB per test so row counts stay deterministic. */
function freshDb() {
  const path = join(tmpdir(), `ai2nao-ghq-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return openDatabase(path);
}

function repoFixture(partial: Partial<GithubApiRepo> = {}): GithubApiRepo {
  return {
    id: 1,
    name: "demo",
    full_name: "alice/demo",
    owner: { login: "alice" },
    description: "a demo",
    private: false,
    fork: false,
    archived: false,
    default_branch: "main",
    html_url: "https://github.com/alice/demo",
    clone_url: "https://github.com/alice/demo.git",
    language: "TypeScript",
    topics: ["cli", "sqlite"],
    stargazers_count: 3,
    forks_count: 1,
    open_issues_count: 0,
    size: 42,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-02-01T00:00:00Z",
    pushed_at: "2024-02-01T00:00:00Z",
    ...partial,
  };
}

function starFixture(partial: { id?: number; starred_at?: string; topics?: string[] } = {}): GithubApiStar {
  const id = partial.id ?? 101;
  return {
    starred_at: partial.starred_at ?? "2024-03-01T00:00:00Z",
    repo: {
      ...repoFixture({
        id,
        name: `star${id}`,
        full_name: `bob/star${id}`,
        owner: { login: "bob" },
        topics: partial.topics ?? ["ml"],
      }),
    },
  };
}

describe("parseTopicsSafe", () => {
  it("returns parsed array for valid JSON", () => {
    expect(parseTopicsSafe('["a","b"]')).toEqual(["a", "b"]);
  });

  it("returns [] for non-string elements", () => {
    expect(parseTopicsSafe('[1,2,3]')).toEqual([]);
  });

  it("returns [] and logs when context provided on bad JSON", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseTopicsSafe("{bad json", "gh_repo.id=5")).toEqual([]);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("returns [] silently when no context", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseTopicsSafe("{bad")).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("upserts + counts", () => {
  it("upsertRepo is idempotent and updates mutable fields on conflict", () => {
    const db = freshDb();
    try {
      upsertRepo(db, repoFixture({ stargazers_count: 1 }), "2024-02-01T00:00:00Z");
      upsertRepo(db, repoFixture({ stargazers_count: 99 }), "2024-02-02T00:00:00Z");
      const row = listRepos(db, { perPage: 10 }).items[0];
      expect(row.stargazers_count).toBe(99);
      expect(countRepos(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("upsertStar / upsertCommitCount round-trip", () => {
    const db = freshDb();
    try {
      upsertRepo(db, repoFixture({ id: 5 }), "2024-01-01T00:00:00Z");
      upsertCommitCount(
        db,
        5,
        { count: 37, defaultBranch: "main", error: null },
        "2024-02-01T00:00:00Z"
      );
      const r = listRepos(db, { perPage: 10 }).items[0];
      expect(r.commit_count).toBe(37);
      expect(r.commit_count_error).toBeNull();

      upsertStar(db, starFixture({ id: 101, starred_at: "2024-03-01T00:00:00Z" }), "2024-03-01T00:00:00Z");
      expect(countStars(db)).toBe(1);
      const s = listStars(db, { perPage: 10 }).items[0];
      expect(s.starred_at).toBe("2024-03-01T00:00:00Z");
      expect(s.topics).toEqual(["ml"]);
    } finally {
      db.close();
    }
  });
});

describe("keyset pagination", () => {
  it("listRepos paginates in created_at DESC / id DESC order", () => {
    const db = freshDb();
    try {
      for (let i = 1; i <= 5; i++) {
        upsertRepo(
          db,
          repoFixture({
            id: i,
            name: `r${i}`,
            full_name: `a/r${i}`,
            created_at: `2024-01-0${i}T00:00:00Z`,
          }),
          "2024-02-01T00:00:00Z"
        );
      }
      const p1 = listRepos(db, { perPage: 2 });
      expect(p1.items.map((r) => r.id)).toEqual([5, 4]);
      expect(p1.nextCursor).toBe(4);

      const p2 = listRepos(db, { perPage: 2, cursor: p1.nextCursor });
      expect(p2.items.map((r) => r.id)).toEqual([3, 2]);

      const p3 = listRepos(db, { perPage: 2, cursor: p2.nextCursor });
      expect(p3.items.map((r) => r.id)).toEqual([1]);
      expect(p3.nextCursor).toBeNull();
    } finally {
      db.close();
    }
  });

  it("listStars cursor uses starred_at timestamp", () => {
    const db = freshDb();
    try {
      for (let i = 1; i <= 5; i++) {
        upsertStar(
          db,
          starFixture({ id: 100 + i, starred_at: `2024-01-0${i}T00:00:00Z` }),
          "2024-03-01T00:00:00Z"
        );
      }
      const p1 = listStars(db, { perPage: 2 });
      expect(p1.items.map((s) => s.starred_at)).toEqual([
        "2024-01-05T00:00:00Z",
        "2024-01-04T00:00:00Z",
      ]);
      expect(p1.nextCursor).toBe("2024-01-04T00:00:00Z");

      const p2 = listStars(db, { perPage: 2, cursor: p1.nextCursor });
      expect(p2.items.map((s) => s.starred_at)).toEqual([
        "2024-01-03T00:00:00Z",
        "2024-01-02T00:00:00Z",
      ]);
      expect(p2.nextCursor).toBe("2024-01-02T00:00:00Z");

      const p3 = listStars(db, { perPage: 2, cursor: p2.nextCursor });
      expect(p3.items.map((s) => s.starred_at)).toEqual([
        "2024-01-01T00:00:00Z",
      ]);
      expect(p3.nextCursor).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("getHeatmapBuckets", () => {
  it("aggregates repo creations and stars by UTC day", () => {
    const db = freshDb();
    try {
      upsertRepo(db, repoFixture({ id: 1, created_at: "2024-05-01T10:00:00Z" }), "2024-06-01T00:00:00Z");
      upsertRepo(db, repoFixture({ id: 2, name: "b", full_name: "a/b", created_at: "2024-05-01T22:00:00Z" }), "2024-06-01T00:00:00Z");
      upsertStar(db, starFixture({ id: 10, starred_at: "2024-05-01T12:00:00Z" }), "2024-06-01T00:00:00Z");
      upsertStar(db, starFixture({ id: 11, starred_at: "2024-05-02T00:00:00Z" }), "2024-06-01T00:00:00Z");
      const buckets = getHeatmapBuckets(db, null, null);
      const m = new Map(buckets.map((b) => [b.day, b]));
      expect(m.get("2024-05-01")).toMatchObject({ repo_count: 2, star_count: 1 });
      expect(m.get("2024-05-02")).toMatchObject({ repo_count: 0, star_count: 1 });
    } finally {
      db.close();
    }
  });

  it("respects since / until bounds", () => {
    const db = freshDb();
    try {
      upsertRepo(db, repoFixture({ id: 1, created_at: "2024-05-01T00:00:00Z" }), "now");
      upsertRepo(db, repoFixture({ id: 2, name: "b", full_name: "a/b", created_at: "2024-05-10T00:00:00Z" }), "now");
      const b = getHeatmapBuckets(db, "2024-05-05", "2024-05-20");
      expect(b.map((x) => x.day)).toEqual(["2024-05-10"]);
    } finally {
      db.close();
    }
  });
});

describe("watermarks + sync state", () => {
  it("getMaxRepoUpdatedAt / getMaxStarredAt reflect max", () => {
    const db = freshDb();
    try {
      expect(getMaxRepoUpdatedAt(db)).toBeNull();
      upsertRepo(db, repoFixture({ id: 1, updated_at: "2024-02-01T00:00:00Z" }), "now");
      upsertRepo(db, repoFixture({ id: 2, name: "b", full_name: "a/b", updated_at: "2024-03-01T00:00:00Z" }), "now");
      expect(getMaxRepoUpdatedAt(db)).toBe("2024-03-01T00:00:00Z");

      expect(getMaxStarredAt(db)).toBeNull();
      upsertStar(db, starFixture({ id: 9, starred_at: "2024-04-01T00:00:00Z" }), "now");
      expect(getMaxStarredAt(db)).toBe("2024-04-01T00:00:00Z");
    } finally {
      db.close();
    }
  });

  it("getSyncState returns defaults and round-trips values", () => {
    const db = freshDb();
    try {
      const empty = getSyncState(db);
      expect(empty.last_full_sync_at).toBeNull();
      expect(empty.in_progress).toBe(false);

      setSyncStateValue(db, "last_full_sync_at", "2024-02-01T00:00:00Z");
      setSyncStateValue(db, "last_full_sync_duration_ms", "1234");
      setSyncStateValue(db, "in_progress", "1");
      const s = getSyncState(db);
      expect(s.last_full_sync_at).toBe("2024-02-01T00:00:00Z");
      expect(s.last_full_sync_duration_ms).toBe(1234);
      expect(s.in_progress).toBe(true);

      setSyncStateValue(db, "last_full_sync_duration_ms", null);
      expect(getSyncState(db).last_full_sync_duration_ms).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("listRepoIdsNeedingCommitCount", () => {
  it("returns all repos when neither onlyMissing nor stale is set", () => {
    const db = freshDb();
    try {
      upsertRepo(db, repoFixture({ id: 1 }), "now");
      upsertRepo(db, repoFixture({ id: 2, name: "b", full_name: "a/b" }), "now");
      expect(listRepoIdsNeedingCommitCount(db).length).toBe(2);
    } finally {
      db.close();
    }
  });

  it("onlyMissing filters out rows that already have a commit count", () => {
    const db = freshDb();
    try {
      upsertRepo(db, repoFixture({ id: 1 }), "now");
      upsertRepo(db, repoFixture({ id: 2, name: "b", full_name: "a/b" }), "now");
      upsertCommitCount(db, 1, { count: 10, defaultBranch: "main", error: null }, "2024-02-01T00:00:00Z");
      const ids = listRepoIdsNeedingCommitCount(db, { onlyMissing: true }).map((r) => r.id);
      expect(ids).toEqual([2]);
    } finally {
      db.close();
    }
  });

  it("staleOlderThan includes rows checked before the cutoff", () => {
    const db = freshDb();
    try {
      upsertRepo(db, repoFixture({ id: 1 }), "now");
      upsertRepo(db, repoFixture({ id: 2, name: "b", full_name: "a/b" }), "now");
      upsertCommitCount(db, 1, { count: 10, defaultBranch: "main", error: null }, "2024-01-01T00:00:00Z");
      upsertCommitCount(db, 2, { count: 20, defaultBranch: "main", error: null }, "2024-03-01T00:00:00Z");
      const stale = listRepoIdsNeedingCommitCount(db, {
        staleOlderThan: "2024-02-01T00:00:00Z",
      }).map((r) => r.id);
      expect(stale).toContain(1);
      expect(stale).not.toContain(2);
    } finally {
      db.close();
    }
  });
});
