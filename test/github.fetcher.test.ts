import { describe, expect, it, vi } from "vitest";
import {
  GithubApiError,
  GithubAuthError,
  fetchCommitCount,
  getAuthenticatedLogin,
  ghFetch,
  listOwnedRepos,
  listStarredRepos,
  parseLinkHeader,
  parsePageParam,
  type GithubApiRepo,
} from "../src/github/fetcher.js";

/**
 * Build a fake `fetch` that returns canned Response-like objects per URL.
 * Records the call log so we can assert pagination/headers behaviour.
 */
function makeFakeFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body: string; headers?: Record<string, string> } | Promise<{ status: number; body: string; headers?: Record<string, string> }>
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    calls.push({ url, init });
    const { status, body, headers } = await handler(url, init);
    return new Response(body, { status, headers });
  };
  return { fetchImpl, calls };
}

function ghRepoFixture(partial: Partial<GithubApiRepo> = {}): GithubApiRepo {
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
    language: null,
    topics: [],
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    size: 0,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    pushed_at: "2024-01-02T00:00:00Z",
    ...partial,
  };
}

describe("parseLinkHeader / parsePageParam", () => {
  it("parses GitHub-style Link header", () => {
    const raw =
      '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=12>; rel="last"';
    const out = parseLinkHeader(raw);
    expect(out.next).toBe("https://api.github.com/user/repos?page=2");
    expect(out.last).toBe("https://api.github.com/user/repos?page=12");
  });

  it("returns {} for null / empty / malformed", () => {
    expect(parseLinkHeader(null)).toEqual({});
    expect(parseLinkHeader("")).toEqual({});
    expect(parseLinkHeader("garbage")).toEqual({});
  });

  it("extracts page param", () => {
    expect(parsePageParam("https://api.github.com/x?page=42")).toBe(42);
    expect(parsePageParam("https://api.github.com/x")).toBeNull();
    expect(parsePageParam("not a url")).toBeNull();
  });
});

describe("ghFetch", () => {
  it("throws GithubAuthError on 401 without retrying", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() => ({
      status: 401,
      body: '{"message":"Bad creds"}',
    }));
    const sleep = vi.fn(async () => {});
    await expect(
      ghFetch({ url: "/user", token: "ghp_x", fetchImpl, sleep })
    ).rejects.toBeInstanceOf(GithubAuthError);
    expect(calls.length).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries 5xx with bounded backoff and eventually surfaces", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() => ({
      status: 502,
      body: "bad gateway",
    }));
    const sleep = vi.fn(async () => {});
    await expect(
      ghFetch({ url: "/user", token: "ghp_x", fetchImpl, sleep })
    ).rejects.toBeInstanceOf(GithubApiError);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(sleep).toHaveBeenCalled();
  });

  it("retries 403 rate limit using Retry-After then succeeds", async () => {
    let n = 0;
    const { fetchImpl } = makeFakeFetch(() => {
      n++;
      if (n === 1) {
        return {
          status: 403,
          body: "rate limit",
          headers: { "retry-after": "1" },
        };
      }
      return { status: 200, body: "{}" };
    });
    const sleep = vi.fn(async () => {});
    const res = await ghFetch({ url: "/user", token: "ghp_x", fetchImpl, sleep });
    expect(res.status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("clamps over-long Retry-After to 60s", async () => {
    let n = 0;
    const { fetchImpl } = makeFakeFetch(() => {
      n++;
      if (n === 1) {
        return {
          status: 429,
          body: "",
          headers: { "retry-after": "999999" },
        };
      }
      return { status: 200, body: "{}" };
    });
    const sleep = vi.fn(async () => {});
    await ghFetch({ url: "/x", token: "ghp_x", fetchImpl, sleep });
    expect(sleep).toHaveBeenCalledWith(60_000);
  });
});

describe("listOwnedRepos", () => {
  it("follows Link rel=next across pages", async () => {
    let n = 0;
    const { fetchImpl, calls } = makeFakeFetch((url) => {
      n++;
      if (n === 1) {
        return {
          status: 200,
          body: JSON.stringify([ghRepoFixture({ id: 1, full_name: "a/1" })]),
          headers: {
            link: `<https://api.github.com/user/repos?page=2>; rel="next"`,
          },
        };
      }
      expect(url).toContain("page=2");
      return {
        status: 200,
        body: JSON.stringify([ghRepoFixture({ id: 2, full_name: "a/2" })]),
      };
    });
    const repos = await listOwnedRepos({ token: "ghp_x" }, { fetchImpl });
    expect(repos.map((r) => r.id)).toEqual([1, 2]);
    expect(calls.length).toBe(2);
  });

  it("stops early when sinceUpdatedAt is reached", async () => {
    const { fetchImpl } = makeFakeFetch(() => ({
      status: 200,
      body: JSON.stringify([
        ghRepoFixture({ id: 1, full_name: "a/1", updated_at: "2024-03-01T00:00:00Z" }),
        ghRepoFixture({ id: 2, full_name: "a/2", updated_at: "2024-01-01T00:00:00Z" }),
      ]),
      headers: {
        link: '<https://api.github.com/user/repos?page=2>; rel="next"',
      },
    }));
    const repos = await listOwnedRepos(
      { token: "ghp_x" },
      { fetchImpl, sinceUpdatedAt: "2024-02-01T00:00:00Z" }
    );
    expect(repos.map((r) => r.id)).toEqual([1]);
  });
});

describe("listStarredRepos", () => {
  it("requires star+json accept header", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() => ({
      status: 200,
      body: JSON.stringify([]),
    }));
    await listStarredRepos({ token: "ghp_x" }, { fetchImpl });
    const accept = (calls[0].init?.headers as Record<string, string> | undefined)?.Accept;
    expect(accept).toBe("application/vnd.github.star+json");
  });

  it("stops early when sinceStarredAt is crossed", async () => {
    const { fetchImpl } = makeFakeFetch(() => ({
      status: 200,
      body: JSON.stringify([
        { starred_at: "2024-03-01T00:00:00Z", repo: ghRepoFixture({ id: 10 }) },
        { starred_at: "2024-01-01T00:00:00Z", repo: ghRepoFixture({ id: 11 }) },
      ]),
      headers: {
        link: '<https://api.github.com/user/starred?page=2>; rel="next"',
      },
    }));
    const out = await listStarredRepos(
      { token: "ghp_x" },
      { fetchImpl, sinceStarredAt: "2024-02-01T00:00:00Z" }
    );
    expect(out.map((s) => s.repo.id)).toEqual([10]);
  });
});

describe("fetchCommitCount", () => {
  it("extracts page number from Link rel=last", async () => {
    const { fetchImpl } = makeFakeFetch(() => ({
      status: 200,
      body: JSON.stringify([{ sha: "aaa" }]),
      headers: {
        link: '<https://api.github.com/repos/alice/demo/commits?per_page=1&page=137>; rel="last"',
      },
    }));
    const r = await fetchCommitCount(ghRepoFixture(), { token: "ghp_x" }, { fetchImpl });
    expect(r.count).toBe(137);
    expect(r.error).toBeNull();
  });

  it("counts array length when no Link header (<=1 commit)", async () => {
    const { fetchImpl } = makeFakeFetch(() => ({
      status: 200,
      body: JSON.stringify([{ sha: "aaa" }]),
    }));
    const r = await fetchCommitCount(ghRepoFixture(), { token: "ghp_x" }, { fetchImpl });
    expect(r.count).toBe(1);
  });

  it("treats 409 as empty repo (0 commits)", async () => {
    const { fetchImpl } = makeFakeFetch(() => ({
      status: 409,
      body: '{"message":"Git Repository is empty."}',
    }));
    const r = await fetchCommitCount(ghRepoFixture(), { token: "ghp_x" }, { fetchImpl });
    expect(r.count).toBe(0);
    expect(r.error).toBe("empty");
  });

  it("returns no_default_branch without fetching when repo has none", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() => ({ status: 200, body: "[]" }));
    const r = await fetchCommitCount(
      ghRepoFixture({ default_branch: null }),
      { token: "ghp_x" },
      { fetchImpl }
    );
    expect(r.error).toBe("no_default_branch");
    expect(calls.length).toBe(0);
  });

  it("returns fetch_failed + redacts token on 404 (non-retryable)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetchImpl } = makeFakeFetch(() => ({
      status: 404,
      body: "not found",
    }));
    try {
      const r = await fetchCommitCount(ghRepoFixture(), { token: "ghp_x" }, { fetchImpl });
      expect(r.error).toBe("fetch_failed");
      const logged = spy.mock.calls.flatMap((c) => c.map(String)).join("\n");
      expect(logged).not.toContain("ghp_x");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("getAuthenticatedLogin", () => {
  it("returns login from /user", async () => {
    const { fetchImpl } = makeFakeFetch(() => ({
      status: 200,
      body: '{"login":"alice"}',
    }));
    expect(await getAuthenticatedLogin({ token: "ghp_x" }, { fetchImpl })).toBe("alice");
  });
});
