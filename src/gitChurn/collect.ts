/**
 * Collect per-repo git line churn into `git_line_churn` (+ `git_line_churn_state`).
 *
 * Correctness rules locked in /plan-eng-review:
 *  - better-sqlite3 transactions are SYNCHRONOUS and cannot wrap the async git
 *    call. So we (1) capture target_head, (2) run git log async, (3) write inside
 *    ONE sync transaction and advance last_synced_sha to that captured head.
 *  - TWO write semantics (must not be conflated):
 *      incremental (last_sha..head, last_sha is an ancestor) -> ACCUMULATE.
 *      rescan (no state / rule_version changed / last_sha not an ancestor /
 *        rebase / force-push / first run) -> DELETE the [floor, now] window for
 *        this repo THEN re-insert (replace). Accumulating on a rescan double-counts.
 *  - rule_version bump forces a rescan so denoise/author/timezone/floor cohort
 *    changes do not leave mixed-cohort rows (the incremental path never self-heals).
 */
import type Database from "better-sqlite3";
import { execGit } from "../git/exec.js";
import { parseNumstat, defaultDenoise } from "./parseNumstat.js";

/** Bump when denoise globs / day bucketing / author rule change so old rows rescan. */
export const GIT_CHURN_RULE_VERSION = 1;

const PRETTY = "--pretty=format:%x00%ad";
const DATE = "--date=format-local:%Y-%m-%d";
const NUMSTAT_MAX_BUFFER = 64 * 1024 * 1024; // large repos' numstat can exceed the 10MB default

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local calendar day (YYYY-MM-DD) of a Date — matches git `--date=format-local`. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

type StateRow = { last_synced_sha: string | null; rule_version: number };

async function isAncestor(cwd: string, ancestor: string, head: string): Promise<boolean> {
  try {
    await execGit(["merge-base", "--is-ancestor", ancestor, head], { cwd });
    return true; // exit 0 = ancestor
  } catch (e) {
    if ((e as { code?: number })?.code === 1) return false; // exit 1 = not ancestor
    throw e; // any other exit = real error
  }
}

export type CollectResult = { mode: "incremental" | "rescan"; days: number };

export async function collectRepoChurn(
  db: Database.Database,
  opts: {
    repoPath: string;
    authorEmail: string;
    /** Lower time bound for a (re)scan. */
    floorSince: Date;
    ruleVersion?: number;
    /** Injectable for tests; defaults to now. */
    nowIso?: string;
  }
): Promise<CollectResult> {
  const ruleVersion = opts.ruleVersion ?? GIT_CHURN_RULE_VERSION;
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const floorDay = localDay(opts.floorSince);

  try {
    const state = db
      .prepare(
        "SELECT last_synced_sha, rule_version FROM git_line_churn_state WHERE repo_path = ?"
      )
      .get(opts.repoPath) as StateRow | undefined;

    const targetHead = (
      await execGit(["rev-parse", "HEAD"], { cwd: opts.repoPath })
    ).trim();

    let mode: "incremental" | "rescan";
    if (!state?.last_synced_sha || state.rule_version !== ruleVersion) {
      mode = "rescan";
    } else if (await isAncestor(opts.repoPath, state.last_synced_sha, targetHead)) {
      mode = "incremental";
    } else {
      mode = "rescan"; // rebase / force-push / branch switch
    }

    const range =
      mode === "incremental"
        ? [`${state!.last_synced_sha}..${targetHead}`]
        : [`--since=${opts.floorSince.toISOString()}`, targetHead];

    const stdout = await execGit(
      [
        "log",
        "--numstat",
        "--no-merges",
        "--use-mailmap",
        `--author=${opts.authorEmail}`,
        PRETTY,
        DATE,
        ...range,
      ],
      { cwd: opts.repoPath, maxBuffer: NUMSTAT_MAX_BUFFER }
    );

    const byDay = parseNumstat(stdout, { isDenoised: defaultDenoise });

    // All git I/O done; now write in ONE synchronous transaction.
    const write = db.transaction(() => {
      if (mode === "rescan") {
        db.prepare(
          "DELETE FROM git_line_churn WHERE project_key = ? AND day >= ?"
        ).run(opts.repoPath, floorDay);
        const ins = db.prepare(
          "INSERT OR REPLACE INTO git_line_churn (project_key, day, added, deleted, commits) VALUES (?, ?, ?, ?, ?)"
        );
        for (const [day, c] of byDay) ins.run(opts.repoPath, day, c.added, c.deleted, c.commits);
      } else {
        const up = db.prepare(
          `INSERT INTO git_line_churn (project_key, day, added, deleted, commits)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project_key, day) DO UPDATE SET
             added = added + excluded.added,
             deleted = deleted + excluded.deleted,
             commits = commits + excluded.commits`
        );
        for (const [day, c] of byDay) up.run(opts.repoPath, day, c.added, c.deleted, c.commits);
      }
      db.prepare(
        `INSERT INTO git_line_churn_state (repo_path, last_synced_sha, rule_version, author_email, updated_at, last_error)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(repo_path) DO UPDATE SET
           last_synced_sha = excluded.last_synced_sha,
           rule_version = excluded.rule_version,
           author_email = excluded.author_email,
           updated_at = excluded.updated_at,
           last_error = NULL`
      ).run(opts.repoPath, targetHead, ruleVersion, opts.authorEmail, nowIso);
    });
    write();

    return { mode, days: byDay.size };
  } catch (e) {
    // Record the failure (keep last_synced_sha so we don't lose ground) and rethrow
    // so the scheduler's per-repo catch counts it.
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare(
      `INSERT INTO git_line_churn_state (repo_path, last_synced_sha, rule_version, author_email, updated_at, last_error)
       VALUES (?, NULL, ?, ?, ?, ?)
       ON CONFLICT(repo_path) DO UPDATE SET updated_at = excluded.updated_at, last_error = excluded.last_error`
    ).run(opts.repoPath, ruleVersion, opts.authorEmail, nowIso, msg);
    throw e;
  }
}
