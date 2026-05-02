import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createApp } from "../src/serve/app.js";
import type { GithubApiRepo, GithubApiStar } from "../src/github/fetcher.js";
import { upsertStar } from "../src/github/queries.js";
import { rebuildAllRepoTags } from "../src/github/tags.js";
import { openDatabase } from "../src/store/open.js";

type App = ReturnType<typeof createApp>;

function freshApp(): { app: App; db: Database.Database } {
  const dbPath = join(
    tmpdir(),
    `ai2nao-ghradarroutes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const db = openDatabase(dbPath);
  const app = createApp({ db });
  return { app, db };
}

function repo(id: number, topics: string[] = ["agent"]): GithubApiRepo {
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
    language: "TypeScript",
    topics,
    stargazers_count: 1,
    forks_count: 0,
    open_issues_count: 0,
    size: 0,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    pushed_at: "2024-01-01T00:00:00Z",
  };
}

function star(id: number): GithubApiStar {
  return {
    starred_at: "2024-06-01T00:00:00Z",
    repo: repo(id),
  };
}

describe("github radar routes", () => {
  let app: App;
  let db: Database.Database;

  beforeEach(() => {
    const env = freshApp();
    app = env.app;
    db = env.db;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed by sqlite failure test */
    }
  });

  it("GET /api/github/radar returns the locked overview DTO shape", async () => {
    upsertStar(db, star(1), "2024-06-01T00:00:00Z");
    rebuildAllRepoTags(db);

    const res = await app.request("/api/github/radar?cluster_limit=5&queue_limit=5");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: { total_stars: number; missing_reason: number };
      thresholds: { stale_before: string; needs_review_before: string };
      clusters: Array<{ tag: string; count: number; missing_reason_count: number }>;
      language_only: unknown[];
      queues: { missing_reason: Array<{ repo_id: number; effective_status: string }> };
    };
    expect(body.counts.total_stars).toBe(1);
    expect(body.counts.missing_reason).toBe(1);
    expect(body.thresholds.stale_before).toBeTruthy();
    expect(body.thresholds.needs_review_before).toBeTruthy();
    expect(body.clusters[0]).toMatchObject({
      tag: "agent",
      count: 1,
      missing_reason_count: 1,
    });
    expect(body.language_only).toEqual([]);
    expect(body.queues.missing_reason[0]).toMatchObject({
      repo_id: 1,
      effective_status: "new",
    });
  });

  it("POST /api/github/radar/notes/:repo_id writes a local note", async () => {
    const res = await app.request("/api/github/radar/notes/42", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "  compare later  ",
        status: "try_next",
        last_reviewed_at: "2024-06-01T00:00:00Z",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      note: { repo_id: number; reason: string; status: string };
    };
    expect(body.note).toMatchObject({
      repo_id: 42,
      reason: "compare later",
      status: "try_next",
    });
  });

  it("POST /api/github/radar/notes/:repo_id rejects invalid inputs", async () => {
    const badRepo = await app.request("/api/github/radar/notes/0", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "", status: "new" }),
    });
    expect(badRepo.status).toBe(400);

    const badStatus = await app.request("/api/github/radar/notes/1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "", status: "later" }),
    });
    expect(badStatus.status).toBe(400);
  });

  it("POST /api/github/radar/notes/:repo_id returns JSON 500 on sqlite failure", async () => {
    db.close();
    const res = await app.request("/api/github/radar/notes/1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "x", status: "new" }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBeTruthy();
  });
});
