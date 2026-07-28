/**
 * Batch git-commit ingestion for the conversation↔commit bridge (T1a).
 *
 * Resolves the global git author, walks every scanned repo
 * (`repos.path_canonical` WHERE missing_since IS NULL), and per repo:
 *   - incremental collect from last_hash..HEAD when a last_hash exists;
 *   - on a signalled rescan (unreachable last_hash) OR first run: delete the
 *     repo's rows THEN full collect(`--since=<sinceDays>.days`);
 *   - upsert, then advance state.last_hash to the fresh HEAD (success).
 * Each repo is error-isolated (mirrors gitChurn/sync.ts): a non-git dir / git
 * failure records a failed state and continues — the walk never throws.
 *
 * `nowIso` is computed ONCE per run and stamped into every repo's
 * `git_commits_state.last_run_at` as that repo finishes (success or failure).
 * That is what lets a progress query report "N of M repos done" with no
 * in-memory state:
 *
 *   done = COUNT(*) FROM git_commits_state
 *          WHERE last_run_at >= <this run's scheduled_task_runs.started_at>
 *
 * Do not make nowIso per-repo — the progress query depends on every repo in one
 * run sharing it.
 */
import type Database from "better-sqlite3";
import pLimit from "p-limit";
import { execGit } from "../git/exec.js";
import { resolveGlobalAuthorEmail } from "../workRecap/service.js";
import {
  collectGitCommits,
  GitCommitsRescanNeeded,
  type CollectResult,
} from "./collect.js";
import {
  deleteCommitsForRepo,
  getCommitState,
  setCommitState,
  upsertCommits,
} from "./store.js";

/** Bounded lower window for a full (re)scan. */
const DEFAULT_SINCE_DAYS = 180;

/** Bounded concurrency for the per-repo git walk. Mirrors gitChurn/sync.ts. */
const CONCURRENCY = 4;

export type IngestGitCommitsResult = {
  status: "success" | "partial" | "failed" | "skipped";
  reposScanned: number;
  commitsUpserted: number;
  authorEmail: string | null;
  errors: string[];
};

export async function ingestGitCommits(
  db: Database.Database,
  opts: { now?: () => Date; authorEmail?: string; sinceDays?: number } = {}
): Promise<IngestGitCommitsResult> {
  const authorEmail = opts.authorEmail ?? resolveGlobalAuthorEmail();
  if (!authorEmail) {
    return {
      status: "skipped",
      reposScanned: 0,
      commitsUpserted: 0,
      authorEmail: null,
      errors: ["no global git author email (git config --global user.email)"],
    };
  }

  const nowIso = (opts.now ? opts.now() : new Date()).toISOString();
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;

  const repos = (
    db
      .prepare("SELECT path_canonical FROM repos WHERE missing_since IS NULL")
      .all() as Array<{ path_canonical: string }>
  ).map((r) => r.path_canonical);

  if (repos.length === 0) {
    return {
      status: "success",
      reposScanned: 0,
      commitsUpserted: 0,
      authorEmail,
      errors: [],
    };
  }

  const errors: string[] = [];
  let reposScanned = 0;
  let reposFailed = 0;
  let commitsUpserted = 0;

  const processRepo = async (repoKey: string): Promise<void> => {
    const state = getCommitState(db, repoKey);
    try {
      let result: CollectResult;
      if (state?.lastHash) {
        try {
          result = await collectGitCommits(repoKey, {
            authorEmail,
            sinceHash: state.lastHash,
          });
        } catch (e) {
          if (e instanceof GitCommitsRescanNeeded) {
            // last_hash unreachable -> wipe ghost/rewritten rows, then full rescan.
            deleteCommitsForRepo(db, repoKey);
            result = await collectGitCommits(repoKey, { authorEmail, sinceDays });
          } else {
            throw e;
          }
        }
      } else {
        // First run: full rescan. deleteCommitsForRepo is idempotent (kills strays).
        deleteCommitsForRepo(db, repoKey);
        result = await collectGitCommits(repoKey, { authorEmail, sinceDays });
      }

      commitsUpserted += upsertCommits(db, repoKey, result.commits, nowIso);

      const head = (
        await execGit(["rev-parse", "HEAD"], { cwd: repoKey })
      ).trim();
      setCommitState(db, repoKey, {
        lastHash: head,
        lastRunAt: nowIso,
        lastStatus: "success",
        lastError: null,
      });
      reposScanned += 1;
    } catch (e) {
      // Error-isolated: record the failure and keep going (never throw out).
      reposFailed += 1;
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${repoKey}: ${msg}`);
      setCommitState(db, repoKey, {
        lastHash: state?.lastHash ?? null, // keep ground so we don't lose the watermark
        lastRunAt: nowIso,
        lastStatus: "failed",
        lastError: msg,
      });
    }
  };

  // 有界并发,与孪生模块 gitChurn/sync.ts 同形同值。并发的只是 git 子进程;
  // better-sqlite3 是同步 API,upsert / setCommitState 仍然串行化。
  const limit = pLimit(CONCURRENCY);
  await Promise.all(repos.map((repoKey) => limit(() => processRepo(repoKey))));

  const status =
    reposFailed === 0 ? "success" : reposScanned === 0 ? "failed" : "partial";
  return { status, reposScanned, commitsUpserted, authorEmail, errors };
}
