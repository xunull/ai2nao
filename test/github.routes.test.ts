import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import {
  setSyncStateValue,
  upsertRepo,
  upsertStar,
} from "../src/github/queries.js";
import { openDatabase } from "../src/store/open.js";
import type { GithubApiRepo, GithubApiStar } from "../src/github/fetcher.js";

/**
 * Each test builds a fresh v5 DB + Hono app and issues requests via
 * `app.request(...)` — the same pattern as test/serve-api.test.ts so we
 * don't need a real HTTP listener.
 */
function freshApp() {
  const dbPath = join(tmpdir(), `ai2nao-ghroutes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDatabase(dbPath);
  const app = createApp({ db });
  return { app, db };
}

function seedRepo(id: number, overrides: Partial<GithubApiRepo> = {}): GithubApiRepo {
  return {
    id,
    name: `r${id}`,
    full_name: `alice/r${id}`,
    owner: { login: "alice" },
    description: null,
    private: false,
    fork: false,
    archived: false,
    default_branch: "main",
    html_url: `https://github.com/alice/r${id}`,
    clone_url: `https://github.com/alice/r${id}.git`,
    language: "TS",
    topics: ["x"],
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    size: 0,
    created_at: `2024-01-${String(id).padStart(2, "0")}T00:00:00Z`,
    updated_at: `2024-02-${String(id).padStart(2, "0")}T00:00:00Z`,
    pushed_at: null,
    ...overrides,
  };
}

function seedStar(id: number, starred_at: string): GithubApiStar {
  return {
    starred_at,
    repo: {
      ...seedRepo(id, { owner: { login: "bob" }, full_name: `bob/r${id}` }),
    },
  };
}

const ORIGINAL_ENV = {
  token: process.env.GITHUB_TOKEN,
  cfg: process.env.AI2NAO_GITHUB_CONFIG,
};

beforeEach(() => {
  delete process.env.GITHUB_TOKEN;
  process.env.AI2NAO_GITHUB_CONFIG = join(tmpdir(), `ai2nao-ghroutes-nope-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
});

afterEach(() => {
  if (ORIGINAL_ENV.token !== undefined) process.env.GITHUB_TOKEN = ORIGINAL_ENV.token;
  else delete process.env.GITHUB_TOKEN;
  if (ORIGINAL_ENV.cfg !== undefined) process.env.AI2NAO_GITHUB_CONFIG = ORIGINAL_ENV.cfg;
  else delete process.env.AI2NAO_GITHUB_CONFIG;
});

describe("GET /api/github/status", () => {
  it("returns unconfigured token + zero counts on a fresh DB", async () => {
    const { app, db } = freshApp();
    try {
      const res = await app.request("http://x/api/github/status");
      expect(res.status).toBe(200);
      const j = (await res.json()) as {
        token: { configured: boolean; source: string | null };
        sync: { last_full_sync_at: string | null; in_progress: boolean };
        counts: { repos: number; stars: number };
      };
      expect(j.token.configured).toBe(false);
      expect(j.counts).toEqual({ repos: 0, stars: 0 });
      expect(j.sync.last_full_sync_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it("reflects seeded counts and sync-state values", async () => {
    const { app, db } = freshApp();
    try {
      upsertRepo(db, seedRepo(1), "2024-02-01T00:00:00Z");
      upsertStar(db, seedStar(99, "2024-03-01T00:00:00Z"), "2024-03-01T00:00:00Z");
      setSyncStateValue(db, "last_full_sync_at", "2024-06-01T00:00:00Z");
      setSyncStateValue(db, "last_full_sync_duration_ms", "500");
      const res = await app.request("http://x/api/github/status");
      const j = (await res.json()) as {
        sync: { last_full_sync_at: string; last_full_sync_duration_ms: number };
        counts: { repos: number; stars: number };
      };
      expect(j.counts).toEqual({ repos: 1, stars: 1 });
      expect(j.sync.last_full_sync_at).toBe("2024-06-01T00:00:00Z");
      expect(j.sync.last_full_sync_duration_ms).toBe(500);
    } finally {
      db.close();
    }
  });
});

describe("GET /api/github/repos", () => {
  it("paginates via next_cursor", async () => {
    const { app, db } = freshApp();
    try {
      for (let i = 1; i <= 3; i++) {
        upsertRepo(db, seedRepo(i), "now");
      }
      const r1 = await app.request("http://x/api/github/repos?per_page=2");
      const j1 = (await r1.json()) as { items: { id: number }[]; next_cursor: number | null };
      expect(j1.items.map((r) => r.id)).toEqual([3, 2]);
      expect(j1.next_cursor).toBe(2);

      const r2 = await app.request(`http://x/api/github/repos?per_page=2&cursor=${j1.next_cursor}`);
      const j2 = (await r2.json()) as { items: { id: number }[]; next_cursor: number | null };
      expect(j2.items.map((r) => r.id)).toEqual([1]);
      expect(j2.next_cursor).toBeNull();
    } finally {
      db.close();
    }
  });

  it("rejects non-numeric cursor silently (returns first page)", async () => {
    const { app, db } = freshApp();
    try {
      upsertRepo(db, seedRepo(1), "now");
      const res = await app.request("http://x/api/github/repos?cursor=abc");
      expect(res.status).toBe(200);
      const j = (await res.json()) as { items: unknown[] };
      expect(j.items.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it("caps per_page at 100", async () => {
    const { app, db } = freshApp();
    try {
      const res = await app.request("http://x/api/github/repos?per_page=10000");
      expect(res.status).toBe(200);
    } finally {
      db.close();
    }
  });
});

describe("GET /api/github/stars", () => {
  it("paginates via starred_at cursor", async () => {
    const { app, db } = freshApp();
    try {
      for (let i = 1; i <= 3; i++) {
        upsertStar(db, seedStar(100 + i, `2024-01-0${i}T00:00:00Z`), "now");
      }
      const r1 = await app.request("http://x/api/github/stars?per_page=2");
      const j1 = (await r1.json()) as {
        items: { starred_at: string }[];
        next_cursor: string | null;
      };
      expect(j1.items.map((s) => s.starred_at)).toEqual([
        "2024-01-03T00:00:00Z",
        "2024-01-02T00:00:00Z",
      ]);
      expect(j1.next_cursor).toBe("2024-01-02T00:00:00Z");

      const r2 = await app.request(
        `http://x/api/github/stars?per_page=2&cursor=${encodeURIComponent(j1.next_cursor!)}`
      );
      const j2 = (await r2.json()) as { items: { starred_at: string }[] };
      expect(j2.items.map((s) => s.starred_at)).toEqual(["2024-01-01T00:00:00Z"]);
    } finally {
      db.close();
    }
  });
});

describe("GET /api/github/heatmap", () => {
  it("aggregates by day across repo and star tables", async () => {
    const { app, db } = freshApp();
    try {
      upsertRepo(db, seedRepo(1, { created_at: "2024-05-01T00:00:00Z" }), "now");
      upsertStar(db, seedStar(10, "2024-05-01T12:00:00Z"), "now");
      upsertStar(db, seedStar(11, "2024-05-03T00:00:00Z"), "now");
      const res = await app.request("http://x/api/github/heatmap");
      const j = (await res.json()) as {
        buckets: { day: string; repo_count: number; star_count: number }[];
      };
      const m = new Map(j.buckets.map((b) => [b.day, b]));
      expect(m.get("2024-05-01")).toMatchObject({ repo_count: 1, star_count: 1 });
      expect(m.get("2024-05-03")).toMatchObject({ repo_count: 0, star_count: 1 });
    } finally {
      db.close();
    }
  });

  it("respects since/until filters", async () => {
    const { app, db } = freshApp();
    try {
      upsertRepo(db, seedRepo(1, { created_at: "2024-05-01T00:00:00Z" }), "now");
      upsertRepo(db, seedRepo(2, { created_at: "2024-07-01T00:00:00Z" }), "now");
      const res = await app.request(
        "http://x/api/github/heatmap?since=2024-06-01&until=2024-12-31"
      );
      const j = (await res.json()) as { buckets: { day: string }[] };
      expect(j.buckets.map((b) => b.day)).toEqual(["2024-07-01"]);
    } finally {
      db.close();
    }
  });
});

describe("GET /api/github/sync-state", () => {
  it("returns the raw gh_sync_state bag", async () => {
    const { app, db } = freshApp();
    try {
      setSyncStateValue(db, "last_full_sync_at", "2024-06-01T00:00:00Z");
      const res = await app.request("http://x/api/github/sync-state");
      const j = (await res.json()) as { last_full_sync_at: string; in_progress: boolean };
      expect(j.last_full_sync_at).toBe("2024-06-01T00:00:00Z");
      expect(j.in_progress).toBe(false);
    } finally {
      db.close();
    }
  });
});
