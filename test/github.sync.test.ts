import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncGithub } from "../src/github/sync.js";
import {
  countRepos,
  countStars,
  getMaxRepoUpdatedAt,
  getMaxStarredAt,
  getSyncState,
  listRepos,
} from "../src/github/queries.js";
import { openDatabase } from "../src/store/open.js";

function freshDb() {
  const p = join(tmpdir(), `ai2nao-ghsync-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return openDatabase(p);
}

/**
 * Dispatch a fake fetch based on URL pattern. Each handler returns
 * `{ status, body, headers }` synchronously and we wrap in a Response.
 */
function makeRouter(routes: { match: RegExp; reply: (url: string) => { status: number; body: string; headers?: Record<string, string> } }[]): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    for (const r of routes) {
      if (r.match.test(url)) {
        const { status, body, headers } = r.reply(url);
        return new Response(body, { status, headers });
      }
    }
    return new Response("no route", { status: 404 });
  };
}

function apiRepo(id: number, overrides: Record<string, unknown> = {}) {
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
    topics: [],
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    size: 0,
    created_at: `2024-01-0${id}T00:00:00Z`,
    updated_at: `2024-02-0${id}T00:00:00Z`,
    pushed_at: `2024-02-0${id}T00:00:00Z`,
    ...overrides,
  };
}

describe("syncGithub", () => {
  it("full sync upserts repos, commit counts, stars, and writes sync state", async () => {
    const db = freshDb();
    try {
      const fetchImpl = makeRouter([
        { match: /\/user$/, reply: () => ({ status: 200, body: '{"login":"alice"}' }) },
        {
          match: /\/user\/repos/,
          reply: () => ({
            status: 200,
            body: JSON.stringify([apiRepo(1), apiRepo(2)]),
          }),
        },
        {
          match: /\/repos\/alice\/r1\/commits/,
          reply: () => ({
            status: 200,
            body: "[{}]",
            headers: {
              link: '<https://api.github.com/repos/alice/r1/commits?per_page=1&page=42>; rel="last"',
            },
          }),
        },
        {
          match: /\/repos\/alice\/r2\/commits/,
          reply: () => ({ status: 200, body: "[{}]" }),
        },
        {
          match: /\/user\/starred/,
          reply: () => ({
            status: 200,
            body: JSON.stringify([
              { starred_at: "2024-03-01T00:00:00Z", repo: apiRepo(100, { full_name: "bob/x", owner: { login: "bob" } }) },
            ]),
          }),
        },
      ]);

      const result = await syncGithub(db, {
        token: "ghp_test",
        mode: "full",
        fetchImpl,
        now: () => new Date("2024-06-01T00:00:00Z"),
      });
      expect(result.login).toBe("alice");
      expect(result.reposUpserted).toBe(2);
      expect(result.starsUpserted).toBe(1);
      expect(result.commitCountsUpdated).toBe(2);
      expect(result.commitCountFailures).toBe(0);
      expect(countRepos(db)).toBe(2);
      expect(countStars(db)).toBe(1);

      const r1 = listRepos(db, { perPage: 10 }).items.find((r) => r.id === 1);
      expect(r1?.commit_count).toBe(42);

      const st = getSyncState(db);
      expect(st.last_full_sync_at).toBe("2024-06-01T00:00:00.000Z");
      expect(st.last_full_sync_error).toBeNull();
      expect(st.in_progress).toBe(false);
      expect(st.last_repos_updated_at).toBe(getMaxRepoUpdatedAt(db));
      expect(st.last_starred_at).toBe(getMaxStarredAt(db));
    } finally {
      db.close();
    }
  });

  it("incremental sync uses watermarks for /user/repos and /user/starred", async () => {
    const db = freshDb();
    try {
      const seenUrls: string[] = [];
      const fetchImpl: typeof fetch = async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        seenUrls.push(url);
        if (/\/user$/.test(url)) {
          return new Response('{"login":"alice"}', { status: 200 });
        }
        if (/\/user\/repos/.test(url)) {
          return new Response(JSON.stringify([apiRepo(1, { updated_at: "2024-02-15T00:00:00Z" })]), {
            status: 200,
          });
        }
        if (/\/repos\/alice\/r1\/commits/.test(url)) {
          return new Response("[]", { status: 200 });
        }
        if (/\/user\/starred/.test(url)) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response("", { status: 404 });
      };

      await syncGithub(db, {
        token: "ghp_x",
        mode: "full",
        fetchImpl: makeRouter([
          { match: /\/user$/, reply: () => ({ status: 200, body: '{"login":"alice"}' }) },
          {
            match: /\/user\/repos/,
            reply: () => ({
              status: 200,
              body: JSON.stringify([apiRepo(1, { updated_at: "2024-02-01T00:00:00Z" })]),
            }),
          },
          { match: /\/repos\/alice\/r1\/commits/, reply: () => ({ status: 200, body: "[]" }) },
          { match: /\/user\/starred/, reply: () => ({ status: 200, body: "[]" }) },
        ]),
        now: () => new Date("2024-05-01T00:00:00Z"),
      });

      seenUrls.length = 0;
      await syncGithub(db, {
        token: "ghp_x",
        mode: "incremental",
        fetchImpl,
        now: () => new Date("2024-06-01T00:00:00Z"),
      });

      expect(seenUrls.some((u) => /\/user\/repos/.test(u))).toBe(true);
      expect(seenUrls.some((u) => /\/user\/starred/.test(u))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("captures commit-count fetch_failed as an error entry, not a crash", async () => {
    const db = freshDb();
    try {
      const fetchImpl = makeRouter([
        { match: /\/user$/, reply: () => ({ status: 200, body: '{"login":"alice"}' }) },
        {
          match: /\/user\/repos/,
          reply: () => ({ status: 200, body: JSON.stringify([apiRepo(1)]) }),
        },
        {
          match: /\/repos\/alice\/r1\/commits/,
          reply: () => ({ status: 404, body: '{"message":"Not Found"}' }),
        },
        { match: /\/user\/starred/, reply: () => ({ status: 200, body: "[]" }) },
      ]);

      const r = await syncGithub(db, {
        token: "ghp_x",
        mode: "full",
        fetchImpl,
      });
      expect(r.commitCountFailures).toBe(1);
      expect(r.commitCountsUpdated).toBe(0);
      const repo = listRepos(db, { perPage: 10 }).items[0];
      expect(repo.commit_count_error).toBe("fetch_failed");
    } finally {
      db.close();
    }
  });

  it("auth failure on /user throws and records last_full_sync_error", async () => {
    const db = freshDb();
    try {
      const fetchImpl = makeRouter([
        { match: /\/user$/, reply: () => ({ status: 401, body: '{"message":"Bad credentials"}' }) },
      ]);
      await expect(
        syncGithub(db, { token: "ghp_bad", mode: "full", fetchImpl })
      ).rejects.toThrow();
      const st = getSyncState(db);
      expect(st.last_full_sync_error).not.toBeNull();
      expect(st.in_progress).toBe(false);
    } finally {
      db.close();
    }
  });
});
