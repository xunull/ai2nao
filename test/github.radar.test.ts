import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { GithubApiRepo, GithubApiStar } from "../src/github/fetcher.js";
import { upsertStar } from "../src/github/queries.js";
import {
  getRadarOverview,
  getStarNote,
  upsertStarNote,
} from "../src/github/radar.js";
import { rebuildAllRepoTags } from "../src/github/tags.js";
import { openDatabase } from "../src/store/open.js";

function freshDb() {
  const path = join(
    tmpdir(),
    `ai2nao-ghradar-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  return openDatabase(path);
}

function repo(partial: Partial<GithubApiRepo>): GithubApiRepo {
  return {
    id: partial.id!,
    name: partial.name ?? `r${partial.id}`,
    full_name: partial.full_name ?? `u/r${partial.id}`,
    owner: { login: "u" },
    description: partial.description ?? null,
    private: false,
    fork: false,
    archived: partial.archived ?? false,
    default_branch: "main",
    html_url: partial.html_url ?? "https://example.com",
    clone_url: "https://example.com.git",
    language: partial.language ?? "TypeScript",
    topics: partial.topics ?? [],
    stargazers_count: partial.stargazers_count ?? 1,
    forks_count: 0,
    open_issues_count: 0,
    size: 0,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    pushed_at: partial.pushed_at ?? "2024-01-01T00:00:00Z",
    ...partial,
  };
}

function star(id: number, partial: Partial<GithubApiRepo> = {}): GithubApiStar {
  return {
    starred_at: partial.created_at ?? "2024-06-01T00:00:00Z",
    repo: repo({ id, ...partial }),
  };
}

describe("github radar schema + notes", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it("creates the local note table without cascading to gh_star", () => {
    const noteTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gh_star_note'")
      .get();
    expect(noteTable).toBeTruthy();

    upsertStar(db, star(1), "2024-06-01T00:00:00Z");
    upsertStarNote(db, {
      repoId: 1,
      reason: "try the CLI",
      status: "try_next",
      lastReviewedAt: "2024-06-02T00:00:00Z",
      now: () => new Date("2024-06-03T00:00:00Z"),
    });
    db.prepare("DELETE FROM gh_star WHERE repo_id = ?").run(1);
    expect(getStarNote(db, 1)?.reason).toBe("try the CLI");
  });

  it("upserts trimmed notes and validates status/repo id", () => {
    const note = upsertStarNote(db, {
      repoId: 42,
      reason: "  good docs  ",
      status: "reviewed",
      now: () => new Date("2024-06-01T00:00:00Z"),
    });
    expect(note.reason).toBe("good docs");
    expect(note.status).toBe("reviewed");
    expect(note.source).toBe("user");

    expect(() =>
      upsertStarNote(db, {
        repoId: 0,
        reason: "",
        status: "new",
      })
    ).toThrow(/positive integer/);
    expect(() =>
      upsertStarNote(db, {
        repoId: 1,
        reason: "",
        status: "later" as never,
      })
    ).toThrow(/status must be one of/);
  });
});

describe("github radar overview", () => {
  let db: Database.Database;
  const now = () => new Date("2026-05-01T00:00:00Z");

  beforeEach(() => {
    db = freshDb();
    upsertStar(
      db,
      star(1, {
        topics: ["agent", "typescript"],
        pushed_at: "2026-04-01T00:00:00Z",
        created_at: "2026-04-20T00:00:00Z",
      }),
      "2026-04-20T00:00:00Z"
    );
    upsertStar(
      db,
      star(2, {
        topics: ["agent"],
        pushed_at: "2024-01-01T00:00:00Z",
        created_at: "2024-06-01T00:00:00Z",
      }),
      "2024-06-01T00:00:00Z"
    );
    upsertStar(
      db,
      star(3, {
        topics: ["database"],
        archived: true,
        pushed_at: "2023-01-01T00:00:00Z",
        created_at: "2023-06-01T00:00:00Z",
      }),
      "2023-06-01T00:00:00Z"
    );
    upsertStar(
      db,
      star(4, {
        topics: [],
        language: "Go",
        pushed_at: "2026-03-01T00:00:00Z",
        created_at: "2024-01-01T00:00:00Z",
      }),
      "2024-01-01T00:00:00Z"
    );
    upsertStarNote(db, {
      repoId: 1,
      reason: "",
      status: "new",
      now,
    });
    upsertStarNote(db, {
      repoId: 2,
      reason: "compare agent frameworks",
      status: "reviewed",
      lastReviewedAt: "2024-01-01T00:00:00Z",
      now,
    });
    upsertStarNote(db, {
      repoId: 3,
      reason: "old database idea",
      status: "retired",
      lastReviewedAt: "2026-01-01T00:00:00Z",
      now,
    });
    upsertStarNote(db, {
      repoId: 4,
      reason: "try for terminal tools",
      status: "try_next",
      lastReviewedAt: "2026-04-01T00:00:00Z",
      now,
    });
    rebuildAllRepoTags(db);
  });

  afterEach(() => db.close());

  it("classifies signals with an injected clock", () => {
    const overview = getRadarOverview(db, { now });
    expect(overview.counts.total_stars).toBe(4);
    expect(overview.counts.missing_reason).toBe(1);
    expect(overview.counts.needs_review).toBe(1);
    expect(overview.counts.stale).toBe(1);
    expect(overview.counts.archived).toBe(1);
    expect(overview.counts.recently_starred).toBe(1);
    expect(overview.counts.active_recently).toBe(2);
    expect(overview.counts.try_next).toBe(1);

    expect(overview.queues.missing_reason[0].signals).toContain("missing_reason");
    expect(overview.queues.needs_review[0].repo_id).toBe(2);
    expect(overview.queues.stale[0].repo_id).toBe(2);
    expect(overview.queues.recently_starred[0].repo_id).toBe(1);
  });

  it("keeps language fallback out of topic clusters", () => {
    const overview = getRadarOverview(db, { now });
    expect(overview.clusters.map((c) => c.tag)).toContain("agent");
    expect(overview.clusters.map((c) => c.tag)).not.toContain("language:go");
    expect(overview.language_only.map((c) => c.tag)).toEqual(["language:go"]);
  });

  it("returns safe topics when one star has corrupt topics_json", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      db.prepare("UPDATE gh_star SET topics_json = ? WHERE repo_id = ?").run("{bad", 1);
      const overview = getRadarOverview(db, { now });
      expect(overview.queues.missing_reason[0].topics).toEqual([]);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
