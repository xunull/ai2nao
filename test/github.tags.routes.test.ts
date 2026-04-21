import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { upsertStar } from "../src/github/queries.js";
import { openDatabase } from "../src/store/open.js";
import {
  rebuildAllRepoTags,
  upsertUserAlias,
} from "../src/github/tags.js";
import type { GithubApiRepo, GithubApiStar } from "../src/github/fetcher.js";
import type Database from "better-sqlite3";

// Local response-shape types — intentionally duplicated from
// web/src/types/github.ts rather than imported, so the backend test
// package doesn't grow a dependency on the web build graph.
type GhTopTagsRes = { items: Array<{ tag: string; count: number }> };
type GhTagHeatmapRes = { xs: string[]; ys: string[]; cells: number[][] };
type GhTaggedReposRes = {
  items: Array<{ repo_id: number; matched_tags: string[] }>;
  next_cursor: string | null;
};
type GhTagAliasesRes = {
  items: Array<{
    from_tag: string;
    to_tag: string;
    source: "preset" | "user";
    note: string | null;
  }>;
};

/**
 * HTTP-layer tests for /api/github/tags/*. Same app.request pattern as
 * the other github route tests. We keep the payload minimal and focus
 * on the contract (query parameter parsing, response shape) rather than
 * re-testing the underlying SQL — those assertions live in
 * github.tags.queries.test.ts.
 */

type App = ReturnType<typeof createApp>;

function freshApp(): { app: App; db: Database.Database } {
  const dbPath = join(
    tmpdir(),
    `ai2nao-ghtagroutes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const db = openDatabase(dbPath);
  const app = createApp({ db });
  return { app, db };
}

function repo(id: number, topics: string[], language = "Python"): GithubApiRepo {
  return {
    id,
    name: `r${id}`,
    full_name: `u/r${id}`,
    owner: { login: "u" },
    description: null,
    private: false,
    fork: false,
    archived: false,
    default_branch: "main",
    html_url: "https://example.com",
    clone_url: "https://example.com.git",
    language,
    topics,
    stargazers_count: 1,
    forks_count: 0,
    open_issues_count: 0,
    size: 0,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    pushed_at: null,
  };
}

function star(id: number, topics: string[], starredAt: string): GithubApiStar {
  return { starred_at: starredAt, repo: repo(id, topics) };
}

function seed(db: Database.Database) {
  upsertStar(db, star(1, ["python", "ml"], "2024-06-01T00:00:00Z"), "2024-06-01T00:00:00Z");
  upsertStar(db, star(2, ["python", "agent"], "2024-05-01T00:00:00Z"), "2024-05-01T00:00:00Z");
  upsertStar(db, star(3, ["rust", "ml"], "2024-07-01T00:00:00Z"), "2024-07-01T00:00:00Z");
  rebuildAllRepoTags(db);
}

describe("GET /api/github/tags/top", () => {
  let app: App;
  let db: Database.Database;
  beforeEach(() => {
    const env = freshApp();
    app = env.app;
    db = env.db;
    seed(db);
  });
  afterEach(() => db.close());

  it("returns items sorted by count desc", async () => {
    const res = await app.request("/api/github/tags/top?limit=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GhTopTagsRes;
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0].count).toBeGreaterThanOrEqual(body.items[1].count);
  });

  it("clamps limit to the 1..500 range", async () => {
    const res = await app.request("/api/github/tags/top?limit=9999");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/github/tags/heatmap", () => {
  let app: App;
  let db: Database.Database;
  beforeEach(() => {
    const env = freshApp();
    app = env.app;
    db = env.db;
    seed(db);
  });
  afterEach(() => db.close());

  it("returns xs/ys/cells with aligned dimensions", async () => {
    const res = await app.request("/api/github/tags/heatmap?grain=month");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GhTagHeatmapRes;
    expect(body.cells.length).toBe(body.ys.length);
    for (const row of body.cells) {
      expect(row.length).toBe(body.xs.length);
    }
  });

  it("accepts comma-separated tag override", async () => {
    const res = await app.request(
      "/api/github/tags/heatmap?grain=year&tags=python,agent"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as GhTagHeatmapRes;
    expect(body.ys.sort()).toEqual(["agent", "python"]);
  });
});

describe("GET /api/github/tags/repos", () => {
  let app: App;
  let db: Database.Database;
  beforeEach(() => {
    const env = freshApp();
    app = env.app;
    db = env.db;
    seed(db);
  });
  afterEach(() => db.close());

  it("empty tags query returns empty list (400-avoidance short-circuit)", async () => {
    const res = await app.request("/api/github/tags/repos");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GhTaggedReposRes;
    expect(body.items).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it("AND mode requires intersection", async () => {
    const res = await app.request(
      "/api/github/tags/repos?tags=python,ml&mode=and"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as GhTaggedReposRes;
    expect(body.items.map((i) => i.repo_id)).toEqual([1]);
  });

  it("OR mode returns union", async () => {
    const res = await app.request(
      "/api/github/tags/repos?tags=agent,rust&mode=or"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as GhTaggedReposRes;
    const ids = body.items.map((i) => i.repo_id).sort();
    expect(ids).toEqual([2, 3]);
  });

  it("invalid mode string defaults to 'or'", async () => {
    const res = await app.request(
      "/api/github/tags/repos?tags=agent&mode=garbage"
    );
    expect(res.status).toBe(200);
  });

  it("keyset cursor works across pages", async () => {
    const p1 = await app.request(
      "/api/github/tags/repos?tags=python,ml,rust,agent&mode=or&per_page=2"
    );
    const b1 = (await p1.json()) as GhTaggedReposRes;
    expect(b1.items.length).toBe(2);
    expect(b1.next_cursor).not.toBeNull();

    const p2 = await app.request(
      `/api/github/tags/repos?tags=python,ml,rust,agent&mode=or&per_page=2&cursor=${encodeURIComponent(
        b1.next_cursor as string
      )}`
    );
    const b2 = (await p2.json()) as GhTaggedReposRes;
    expect(b2.items.length).toBe(1);
    expect(b2.next_cursor).toBeNull();
  });
});

describe("GET /api/github/tags/aliases", () => {
  let app: App;
  let db: Database.Database;
  beforeEach(() => {
    const env = freshApp();
    app = env.app;
    db = env.db;
    upsertUserAlias(db, "js", "javascript", "user override");
  });
  afterEach(() => db.close());

  it("lists aliases with source filter", async () => {
    const res = await app.request("/api/github/tags/aliases?source=user");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GhTagAliasesRes;
    expect(body.items.length).toBe(1);
    expect(body.items[0].from_tag).toBe("js");
    expect(body.items[0].source).toBe("user");
  });
});
