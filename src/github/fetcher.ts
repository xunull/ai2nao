/**
 * GitHub REST v3 client used by `src/github/sync.ts`. Intentionally hand-rolled
 * (no Octokit) because ai2nao has a zero-dep goal and we only need 3 endpoints:
 *
 *   GET /user/repos?affiliation=owner
 *   GET /user/starred  (with Accept: application/vnd.github.star+json for starred_at)
 *   GET /repos/:owner/:repo/commits?per_page=1  (for commit count via Link rel=last)
 *
 * All network I/O goes through `ghFetch`, which:
 *   - adds auth + UA + Accept headers
 *   - handles 403 primary rate-limit (X-RateLimit-Remaining: 0) and 403/429
 *     secondary rate-limit (Retry-After) with bounded exponential backoff
 *   - redacts `Authorization: Bearer gh*` in every log path via `redactAuth`
 *   - surfaces `error.cause` from Node's fetch without leaking the header bag
 */

import type { GithubConfig } from "./config.js";

const DEFAULT_API_BASE = "https://api.github.com";
const USER_AGENT = "ai2nao-github-mirror";
const MAX_RETRIES = 3;
const PER_PAGE = 100;

export class GithubApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly retryable: boolean;
  constructor(message: string, opts: { status: number; url: string; retryable: boolean; cause?: unknown }) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = "GithubApiError";
    this.status = opts.status;
    this.url = opts.url;
    this.retryable = opts.retryable;
  }
}

export class GithubAuthError extends GithubApiError {
  constructor(url: string) {
    super("GitHub API returned 401 — token is invalid or lacks required scope", {
      status: 401,
      url,
      retryable: false,
    });
    this.name = "GithubAuthError";
  }
}

/**
 * Mask any header named `authorization` (case-insensitive) and any string
 * literal starting with `Bearer gh` anywhere inside the input. Used by every
 * log path so token literals never reach stderr even on unexpected shapes
 * (e.g. `error.cause` being a Node UND_ERR object with nested headers).
 */
export function redactAuth<T>(obj: T): T {
  const BEARER = /\bBearer\s+gh[opusr]_[A-Za-z0-9_]+/g;
  const TOKEN = /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g;
  const seen = new WeakSet<object>();

  function walk(v: unknown): unknown {
    if (typeof v === "string") {
      return v.replace(BEARER, "Bearer ***").replace(TOKEN, "***");
    }
    if (v === null || v === undefined) return v;
    if (typeof v !== "object") return v;
    if (seen.has(v as object)) return v;
    seen.add(v as object);

    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k.toLowerCase() === "authorization") {
        out[k] = "***";
      } else {
        out[k] = walk(val);
      }
    }
    return out;
  }

  return walk(obj) as T;
}

export type GhFetchOptions = {
  /** Absolute URL or path starting with `/`. Relative paths resolve against `apiBase`. */
  url: string;
  apiBase?: string;
  token: string;
  accept?: string;
  /** Injected for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Overridable sleep for tests; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** AbortSignal propagated to fetch; rate-limit waits are still bounded internally. */
  signal?: AbortSignal;
};

export type GhFetchResult = {
  status: number;
  headers: Headers;
  bodyText: string;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveUrl(url: string, apiBase: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const base = apiBase.replace(/\/$/, "");
  return url.startsWith("/") ? `${base}${url}` : `${base}/${url}`;
}

function jitter(ms: number): number {
  const r = 0.75 + Math.random() * 0.5;
  return Math.round(ms * r);
}

/**
 * Compute wait time (ms) for a 403/429 response, clamped to 60s max so a
 * bogus `Retry-After: 999999` or a clock-skew `X-RateLimit-Reset` never
 * hangs the CLI for minutes.
 */
function rateLimitWaitMs(headers: Headers, attempt: number): number {
  const MAX_WAIT = 60_000;
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const sec = parseInt(retryAfter, 10);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.min(MAX_WAIT, sec * 1000);
    }
  }
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining === "0" && reset) {
    const resetSec = parseInt(reset, 10);
    if (Number.isFinite(resetSec)) {
      const waitMs = resetSec * 1000 - Date.now();
      if (waitMs > 0) return Math.min(MAX_WAIT, waitMs);
    }
  }
  return Math.min(MAX_WAIT, jitter(1000 * Math.pow(2, attempt)));
}

/**
 * Single-request wrapper with auth injection, rate-limit retries, and
 * redacted error messages. Returns the raw text body; callers parse JSON
 * (ghFetchJson) or inspect headers (fetchCommitCount reads Link).
 */
export async function ghFetch(opts: GhFetchOptions): Promise<GhFetchResult> {
  const {
    url,
    apiBase = DEFAULT_API_BASE,
    token,
    accept = "application/vnd.github+json",
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    signal,
  } = opts;
  const full = resolveUrl(url, apiBase);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchImpl(full, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: accept,
          "User-Agent": USER_AGENT,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal,
      });

      if (res.status === 401) {
        throw new GithubAuthError(full);
      }

      if (res.status === 403 || res.status === 429) {
        const wait = rateLimitWaitMs(res.headers, attempt);
        if (attempt < MAX_RETRIES) {
          await sleep(wait);
          continue;
        }
        const bodyText = await res.text().catch(() => "");
        throw new GithubApiError(
          `GitHub rate limit exceeded after ${MAX_RETRIES} retries (status ${res.status})`,
          { status: res.status, url: full, retryable: true, cause: redactAuth({ bodyText: bodyText.slice(0, 500) }) }
        );
      }

      if (res.status >= 500) {
        if (attempt < MAX_RETRIES) {
          await sleep(jitter(1000 * Math.pow(2, attempt)));
          continue;
        }
      }

      const bodyText = await res.text();
      if (!res.ok) {
        throw new GithubApiError(
          `GitHub ${res.status} ${res.statusText} for ${redactPath(full)}`,
          { status: res.status, url: full, retryable: res.status >= 500, cause: redactAuth({ bodyText: bodyText.slice(0, 500) }) }
        );
      }
      return { status: res.status, headers: res.headers, bodyText };
    } catch (e) {
      lastErr = e;
      if (e instanceof GithubAuthError) throw e;
      if (e instanceof GithubApiError && !e.retryable) throw e;
      if (attempt < MAX_RETRIES) {
        await sleep(jitter(1000 * Math.pow(2, attempt)));
        continue;
      }
      if (e instanceof GithubApiError) throw e;
      throw new GithubApiError(`GitHub fetch failed: ${redactAuth(String(e))}`, {
        status: 0,
        url: full,
        retryable: true,
        cause: redactAuth(e),
      });
    }
  }
  throw new GithubApiError(`GitHub fetch exhausted retries: ${redactAuth(String(lastErr))}`, {
    status: 0,
    url: full,
    retryable: true,
    cause: redactAuth(lastErr),
  });
}

/**
 * Strip query string and fragments from a URL when logging: we don't want
 * per_page cursors or `since=<ISO>` timestamps making log lines churn.
 */
function redactPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

export async function ghFetchJson<T>(opts: GhFetchOptions): Promise<{ data: T; headers: Headers }> {
  const res = await ghFetch(opts);
  try {
    const data = JSON.parse(res.bodyText) as T;
    return { data, headers: res.headers };
  } catch (e) {
    throw new GithubApiError(
      `GitHub response was not valid JSON (status ${res.status})`,
      { status: res.status, url: opts.url, retryable: false, cause: redactAuth(e) }
    );
  }
}

/**
 * Parse the `Link` response header (RFC 5988) into a {rel: url} map.
 * Example input:
 *   <https://api.github.com/user/repos?page=2>; rel="next",
 *   <https://api.github.com/user/repos?page=12>; rel="last"
 */
export function parseLinkHeader(link: string | null): Record<string, string> {
  if (!link) return {};
  const out: Record<string, string> = {};
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

/** Extract `?page=N` from a URL string; returns null if absent or malformed. */
export function parsePageParam(url: string): number | null {
  try {
    const u = new URL(url);
    const p = u.searchParams.get("page");
    if (!p) return null;
    const n = parseInt(p, 10);
    return Number.isFinite(n) && n >= 1 ? n : null;
  } catch {
    return null;
  }
}

export type GithubApiRepo = {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  default_branch: string | null;
  html_url: string;
  clone_url: string | null;
  language: string | null;
  topics?: string[];
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  size: number;
  created_at: string;
  updated_at: string;
  pushed_at: string | null;
};

export type GithubApiStar = {
  starred_at: string;
  repo: GithubApiRepo;
};

/**
 * List the authenticated user's owned repos. Follows pagination via `Link:
 * rel="next"`. Includes topics (`Accept: application/vnd.github+json` is
 * enough since API v2022-11-28; no separate topics preview needed).
 *
 * `sinceUpdatedAt` (optional ISO8601) is used client-side to stop pagination
 * early on incremental syncs — GitHub sorts `/user/repos?sort=updated` desc
 * by default, so once we see a repo older than the watermark we can bail.
 */
export async function listOwnedRepos(
  config: { token: string; apiBase?: string },
  options?: { sinceUpdatedAt?: string; fetchImpl?: typeof fetch }
): Promise<GithubApiRepo[]> {
  const out: GithubApiRepo[] = [];
  let url = `/user/repos?affiliation=owner&sort=updated&direction=desc&per_page=${PER_PAGE}`;
  while (url) {
    const { data, headers } = await ghFetchJson<GithubApiRepo[]>({
      url,
      token: config.token,
      apiBase: config.apiBase,
      fetchImpl: options?.fetchImpl,
    });
    if (options?.sinceUpdatedAt) {
      const cutoff = options.sinceUpdatedAt;
      let stop = false;
      for (const r of data) {
        if (r.updated_at < cutoff) {
          stop = true;
          break;
        }
        out.push(r);
      }
      if (stop) return out;
    } else {
      out.push(...data);
    }
    const links = parseLinkHeader(headers.get("link"));
    url = links.next ? stripApiBase(links.next, config.apiBase ?? DEFAULT_API_BASE) : "";
  }
  return out;
}

/**
 * List the authenticated user's starred repos with `starred_at` timestamps.
 * Requires the `application/vnd.github.star+json` Accept header; without it
 * the response shape collapses to a bare repo object and `starred_at` is lost.
 */
export async function listStarredRepos(
  config: { token: string; apiBase?: string },
  options?: { sinceStarredAt?: string; fetchImpl?: typeof fetch }
): Promise<GithubApiStar[]> {
  const out: GithubApiStar[] = [];
  let url = `/user/starred?sort=created&direction=desc&per_page=${PER_PAGE}`;
  while (url) {
    const { data, headers } = await ghFetchJson<GithubApiStar[]>({
      url,
      token: config.token,
      apiBase: config.apiBase,
      accept: "application/vnd.github.star+json",
      fetchImpl: options?.fetchImpl,
    });
    if (options?.sinceStarredAt) {
      const cutoff = options.sinceStarredAt;
      let stop = false;
      for (const s of data) {
        if (s.starred_at <= cutoff) {
          stop = true;
          break;
        }
        out.push(s);
      }
      if (stop) return out;
    } else {
      out.push(...data);
    }
    const links = parseLinkHeader(headers.get("link"));
    url = links.next ? stripApiBase(links.next, config.apiBase ?? DEFAULT_API_BASE) : "";
  }
  return out;
}

function stripApiBase(abs: string, apiBase: string): string {
  const b = apiBase.replace(/\/$/, "");
  return abs.startsWith(b) ? abs.slice(b.length) : abs;
}

export type CommitCountResult = {
  count: number | null;
  defaultBranch: string | null;
  /** "empty" = 0-commit repo, "no_default_branch" = empty-head repo, "fetch_failed" = network/API error */
  error: "empty" | "no_default_branch" | "fetch_failed" | null;
};

/**
 * Fetch the commit count for a single repo using the Link-header trick:
 *   GET /repos/:owner/:repo/commits?per_page=1&sha=<default_branch>
 *
 * GitHub returns `Link: <...?page=N>; rel="last"`, and N equals the total
 * commit count. This costs a single API call per repo regardless of repo size.
 *
 * Edge cases handled in-band (caller doesn't throw for these):
 *   - 409 Conflict  → empty repo (0 commits) ⇒ count=0, error="empty"
 *   - missing default_branch ⇒ count=null, error="no_default_branch"
 *   - no Link header (single page ≤ 1 commit) ⇒ count = length of returned array
 *   - network/API error ⇒ count=null, error="fetch_failed"; caller should
 *     still persist the row so we don't retry forever in tight loops
 */
export async function fetchCommitCount(
  repo: GithubApiRepo,
  config: { token: string; apiBase?: string },
  options?: { fetchImpl?: typeof fetch }
): Promise<CommitCountResult> {
  if (!repo.default_branch) {
    return { count: null, defaultBranch: null, error: "no_default_branch" };
  }
  const sha = encodeURIComponent(repo.default_branch);
  const path = `/repos/${repo.owner.login}/${repo.name}/commits?per_page=1&sha=${sha}`;
  try {
    const res = await ghFetch({
      url: path,
      token: config.token,
      apiBase: config.apiBase,
      fetchImpl: options?.fetchImpl,
    });
    const link = res.headers.get("link");
    const links = parseLinkHeader(link);
    if (links.last) {
      const page = parsePageParam(links.last);
      if (page !== null) {
        return { count: page, defaultBranch: repo.default_branch, error: null };
      }
    }
    let arr: unknown;
    try {
      arr = JSON.parse(res.bodyText) as unknown;
    } catch {
      arr = [];
    }
    const count = Array.isArray(arr) ? arr.length : 0;
    return { count, defaultBranch: repo.default_branch, error: null };
  } catch (e) {
    if (e instanceof GithubApiError && e.status === 409) {
      return { count: 0, defaultBranch: repo.default_branch, error: "empty" };
    }
    console.error(
      `github: commit count failed for ${repo.full_name}:`,
      redactAuth(e instanceof Error ? e.message : String(e))
    );
    return { count: null, defaultBranch: repo.default_branch, error: "fetch_failed" };
  }
}

/** Get the authenticated user's login (cheap call; used as a sanity check at sync start). */
export async function getAuthenticatedLogin(
  config: { token: string; apiBase?: string },
  options?: { fetchImpl?: typeof fetch }
): Promise<string> {
  const { data } = await ghFetchJson<{ login: string }>({
    url: "/user",
    token: config.token,
    apiBase: config.apiBase,
    fetchImpl: options?.fetchImpl,
  });
  return data.login;
}

export function defaultApiBase(cfg: GithubConfig | undefined): string {
  return cfg?.apiBase?.trim() || DEFAULT_API_BASE;
}
