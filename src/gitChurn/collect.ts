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
export const GIT_CHURN_RULE_VERSION = 2;

// %H sha / %ae 作者(走 --use-mailmap) / %aI 带偏移的 ISO / %ad 由 --date 决定的本地日历日。
// %x1f 是单元分隔符,与 %x00 的提交分隔符配套;sha、邮箱、ISO 日期都不可能含它。
const PRETTY = "--pretty=format:%x00%H%x1f%ae%x1f%aI%x1f%ad";
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

/**
 * `git merge-base --is-ancestor` 的三种结局:
 *   exit 0   → 是祖先,可以走增量
 *   exit 1   → 不是祖先(rebase / force-push / 切分支)→ 重扫
 *   exit 128 → **那个 sha 在仓库里已经不存在了**(被 gc、shallow clone、
 *              分支删除、仓库重建)。这一支原来是 `throw`,而外层 catch 只写
 *              `last_error` **不清 last_synced_sha** —— 于是那个仓库永远卡在报错、
 *              永远进不了重扫。真库实测有活实例:`insight-git` 的
 *              92dfd4a6 被 gc 掉后,数据冻结在 2026-01-04 一行,漏掉了 8 天 27 个提交
 *              (V60 的 rule_version bump 恰好绕过 isAncestor 才把它治好)。
 *              所以这一支也当「不是祖先」→ 重扫,让它自愈。
 */
async function isAncestor(cwd: string, ancestor: string, head: string): Promise<boolean> {
  try {
    await execGit(["merge-base", "--is-ancestor", ancestor, head], { cwd });
    return true;
  } catch (e) {
    const code = (e as { code?: number })?.code;
    if (code === 1 || code === 128) return false;
    throw e; // 其余(比如 git 不存在)仍是真错误
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

    const commits = parseNumstat(stdout, { isDenoised: defaultDenoise });
    // 本次涉及的天 —— rescan 时用来清掉这些天上的遗留行,见下。
    const touchedDays = [...new Set(commits.map((c) => c.day))];

    // All git I/O done; now write in ONE synchronous transaction.
    const write = db.transaction(() => {
      if (mode === "rescan") {
        db.prepare(
          "DELETE FROM git_commit_churn WHERE project_key = ? AND day >= ?"
        ).run(opts.repoPath, floorDay);
        // `--since` 过滤的是 **committer** date,而 day 来自 %ad(**author** date),
        // 两者能差一年多(真库有 author=2024-04-23 / committer=2026-07-15 的提交)。
        // 这类提交在窗口内会被产出,但它的 day 在 floorDay 之下,上面那条删窗够不着 ——
        // 不清掉同一天的遗留行就会变成「遗留行 + 真提交行」两条,视图 SUM 算两遍。
        if (touchedDays.length > 0) {
          const holes = touchedDays.map(() => "?").join(",");
          db.prepare(
            `DELETE FROM git_commit_churn
              WHERE project_key = ? AND is_legacy = 1 AND day IN (${holes})`
          ).run(opts.repoPath, ...touchedDays);
        }
      }
      {
        // 两路共用同一条写入:主键 (project_key, sha) 让它天然幂等。
        // v1 的累加语义(以及为守住它而存在的「重扫不双重计数」单测)到此不再需要。
        const ins = db.prepare(
          `INSERT OR REPLACE INTO git_commit_churn
             (project_key, sha, author_email, authored_at, day, added, deleted, commits, is_legacy)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`
        );
        for (const c of commits) {
          ins.run(opts.repoPath, c.sha, c.authorEmail, c.authoredAt, c.day, c.added, c.deleted);
        }
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

    return { mode, days: touchedDays.length };
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
