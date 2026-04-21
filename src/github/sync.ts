/**
 * Orchestrates one sync run end-to-end:
 *
 *   1. Sanity-check the token (GET /user → login)
 *   2. Fetch owned repos (paginated) and upsert each in a per-item tx
 *   3. For each repo missing/stale commit_count, run fetchCommitCount
 *      in parallel with a hand-written semaphore (concurrency = 5)
 *   4. Fetch starred repos (paginated) and upsert each in a per-item tx
 *   5. Update `gh_sync_state` watermarks + duration + error fields
 *
 * Critical invariant (AGENTS.md + eng-review): `better-sqlite3`
 * transactions are SYNCHRONOUS — we must never await inside
 * `db.transaction(fn)`. All `ghFetch(...)` calls happen in the outer
 * async function; each per-item tx only contains pure SQL.
 */

import type Database from "better-sqlite3";
import {
  fetchCommitCount,
  getAuthenticatedLogin,
  listOwnedRepos,
  listStarredRepos,
  redactAuth,
  type GithubApiRepo,
  type GithubApiStar,
  type CommitCountResult,
} from "./fetcher.js";
import {
  getMaxRepoUpdatedAt,
  getMaxStarredAt,
  listRepoIdsNeedingCommitCount,
  setSyncStateValue,
  upsertCommitCount,
  upsertRepo,
  upsertStar,
} from "./queries.js";
import {
  rebuildAllRepoTags,
  rebuildRepoTagsForIds,
  type RebuildStats,
} from "./tags.js";

export type SyncMode = "full" | "incremental";

export type SyncGithubOptions = {
  token: string;
  apiBase?: string;
  mode: SyncMode;
  /** Override for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Periodic progress callback for CLI (stderr) / Web (log buffer). */
  onProgress?: (ev: SyncProgress) => void;
  /** Clock override for deterministic tests. */
  now?: () => Date;
};

export type SyncProgress =
  | { phase: "login"; login: string }
  | { phase: "repos"; fetched: number; upserted: number }
  | { phase: "commit-counts"; done: number; total: number }
  | { phase: "stars"; fetched: number; upserted: number }
  | { phase: "tags-rebuild"; scanned: number; inserted: number }
  | { phase: "done"; durationMs: number };

export type SyncGithubResult = {
  mode: SyncMode;
  login: string;
  reposUpserted: number;
  starsUpserted: number;
  commitCountsUpdated: number;
  commitCountFailures: number;
  /** Tag pivot rebuild stats; null if rebuild was skipped (no stars changed). */
  tagsRebuild: RebuildStats | null;
  durationMs: number;
  errors: string[];
};

const COMMIT_COUNT_CONCURRENCY = 5;

export async function syncGithub(
  db: Database.Database,
  opts: SyncGithubOptions
): Promise<SyncGithubResult> {
  const now = opts.now ?? (() => new Date());
  const started = now();

  setSyncStateValue(db, "in_progress", "1");
  const errors: string[] = [];
  let login = "";
  let reposUpserted = 0;
  let starsUpserted = 0;
  let commitCountsUpdated = 0;
  let commitCountFailures = 0;

  try {
    login = await getAuthenticatedLogin(
      { token: opts.token, apiBase: opts.apiBase },
      { fetchImpl: opts.fetchImpl }
    );
    opts.onProgress?.({ phase: "login", login });

    const sinceUpdatedAt =
      opts.mode === "incremental" ? getMaxRepoUpdatedAt(db) ?? undefined : undefined;

    const repos = await listOwnedRepos(
      { token: opts.token, apiBase: opts.apiBase },
      { sinceUpdatedAt, fetchImpl: opts.fetchImpl }
    );
    opts.onProgress?.({ phase: "repos", fetched: repos.length, upserted: 0 });

    const nowIso = now().toISOString();
    for (const r of repos) {
      try {
        const tx = db.transaction((row: GithubApiRepo) => upsertRepo(db, row, nowIso));
        tx(r);
        reposUpserted++;
      } catch (e) {
        errors.push(
          `upsert repo ${r.full_name} failed: ${redactAuth(e instanceof Error ? e.message : String(e))}`
        );
      }
    }
    opts.onProgress?.({ phase: "repos", fetched: repos.length, upserted: reposUpserted });

    const staleCutoff =
      opts.mode === "full"
        ? undefined
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const needingCommitCount = listRepoIdsNeedingCommitCount(db, {
      onlyMissing: opts.mode === "incremental" && !staleCutoff,
      staleOlderThan: staleCutoff,
    });

    if (needingCommitCount.length > 0) {
      opts.onProgress?.({
        phase: "commit-counts",
        done: 0,
        total: needingCommitCount.length,
      });
      let done = 0;
      const runOne = async (r: (typeof needingCommitCount)[number]): Promise<void> => {
        const repoForApi: GithubApiRepo = {
          id: r.id,
          name: r.name,
          full_name: r.full_name,
          owner: { login: r.owner },
          description: null,
          private: false,
          fork: false,
          archived: false,
          default_branch: r.default_branch,
          html_url: "",
          clone_url: null,
          language: null,
          topics: [],
          stargazers_count: 0,
          forks_count: 0,
          open_issues_count: 0,
          size: 0,
          created_at: "",
          updated_at: "",
          pushed_at: null,
        };
        let result: CommitCountResult;
        try {
          result = await fetchCommitCount(
            repoForApi,
            { token: opts.token, apiBase: opts.apiBase },
            { fetchImpl: opts.fetchImpl }
          );
        } catch (e) {
          errors.push(
            `commit count ${r.full_name} failed: ${redactAuth(e instanceof Error ? e.message : String(e))}`
          );
          result = { count: null, defaultBranch: r.default_branch, error: "fetch_failed" };
        }
        try {
          const tx = db.transaction(() => upsertCommitCount(db, r.id, result, now().toISOString()));
          tx();
          if (result.error === "fetch_failed") commitCountFailures++;
          else commitCountsUpdated++;
        } catch (e) {
          errors.push(
            `upsert commit count ${r.full_name} failed: ${redactAuth(e instanceof Error ? e.message : String(e))}`
          );
        }
        done++;
        if (done % 5 === 0 || done === needingCommitCount.length) {
          opts.onProgress?.({
            phase: "commit-counts",
            done,
            total: needingCommitCount.length,
          });
        }
      };

      await runWithConcurrency(needingCommitCount, COMMIT_COUNT_CONCURRENCY, runOne);
    }

    const sinceStarredAt =
      opts.mode === "incremental" ? getMaxStarredAt(db) ?? undefined : undefined;
    const stars = await listStarredRepos(
      { token: opts.token, apiBase: opts.apiBase },
      { sinceStarredAt, fetchImpl: opts.fetchImpl }
    );
    opts.onProgress?.({ phase: "stars", fetched: stars.length, upserted: 0 });
    const upsertedStarIds: number[] = [];
    for (const s of stars) {
      try {
        const tx = db.transaction((row: GithubApiStar) => upsertStar(db, row, nowIso));
        tx(s);
        starsUpserted++;
        upsertedStarIds.push(s.repo.id);
      } catch (e) {
        errors.push(
          `upsert star ${s.repo.full_name} failed: ${redactAuth(e instanceof Error ? e.message : String(e))}`
        );
      }
    }
    opts.onProgress?.({ phase: "stars", fetched: stars.length, upserted: starsUpserted });

    // Rebuild tag pivot table outside the upsert loops (synchronous SQLite,
    // but kept as a separate phase so progress reporting stays readable).
    //
    // Full sync: nuke + rebuild from every star row — cheap even at 10k stars.
    // Incremental sync: rebuild only repos we actually just upserted. Stars
    //   that didn't change retain their existing gh_repo_tag rows.
    //
    // Note: alias edits do NOT trigger rebuild; users run `ai2nao github tags
    // rebuild` explicitly after editing aliases.
    let tagsRebuild: RebuildStats | null = null;
    try {
      if (opts.mode === "full") {
        tagsRebuild = rebuildAllRepoTags(db);
      } else if (upsertedStarIds.length > 0) {
        tagsRebuild = rebuildRepoTagsForIds(db, upsertedStarIds);
      }
      if (tagsRebuild) {
        opts.onProgress?.({
          phase: "tags-rebuild",
          scanned: tagsRebuild.starsScanned,
          inserted: tagsRebuild.tagsInserted,
        });
      }
    } catch (e) {
      errors.push(
        `tag rebuild failed: ${redactAuth(e instanceof Error ? e.message : String(e))}`
      );
    }

    const finishedIso = now().toISOString();
    const durationMs = now().getTime() - started.getTime();
    const key = opts.mode === "full" ? "last_full_sync_at" : "last_incremental_sync_at";
    const durKey =
      opts.mode === "full" ? "last_full_sync_duration_ms" : "last_incremental_sync_duration_ms";
    const errKey =
      opts.mode === "full" ? "last_full_sync_error" : "last_incremental_sync_error";
    setSyncStateValue(db, key, finishedIso);
    setSyncStateValue(db, durKey, String(durationMs));
    setSyncStateValue(db, errKey, errors.length > 0 ? errors.slice(0, 5).join("\n") : null);

    const maxRepoUpd = getMaxRepoUpdatedAt(db);
    const maxStar = getMaxStarredAt(db);
    if (maxRepoUpd) setSyncStateValue(db, "last_repos_updated_at", maxRepoUpd);
    if (maxStar) setSyncStateValue(db, "last_starred_at", maxStar);

    opts.onProgress?.({ phase: "done", durationMs });
    return {
      mode: opts.mode,
      login,
      reposUpserted,
      starsUpserted,
      commitCountsUpdated,
      commitCountFailures,
      tagsRebuild,
      durationMs,
      errors,
    };
  } catch (e) {
    const msg = redactAuth(e instanceof Error ? e.message : String(e));
    const durationMs = now().getTime() - started.getTime();
    const errKey =
      opts.mode === "full" ? "last_full_sync_error" : "last_incremental_sync_error";
    const durKey =
      opts.mode === "full" ? "last_full_sync_duration_ms" : "last_incremental_sync_duration_ms";
    setSyncStateValue(db, errKey, msg);
    setSyncStateValue(db, durKey, String(durationMs));
    throw e;
  } finally {
    setSyncStateValue(db, "in_progress", "0");
  }
}

/**
 * Hand-rolled async semaphore: spawn up to `concurrency` promises at once,
 * each consuming the next item from a shared index. Preserves input order for
 * failure messages but not for completion timing.
 *
 * Kept local (not a new dep) per the AGENTS zero-dep rule.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const n = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = next++;
          if (idx >= items.length) return;
          try {
            await fn(items[idx]);
          } catch {
            /* fn handles its own errors via the errors[] list */
          }
        }
      })()
    );
  }
  await Promise.all(workers);
}
