/**
 * git_commits 写侧:幂等 upsert(ON CONFLICT)+ 每仓库增量水位 git_commits_state。
 *
 * project_key = slugFromPath(repo_key),与三源对话侧 project 正向编码一致,便于
 * 后续按项目把提交与对话关联(对话↔提交桥两侧都正向编码后比较)。
 */
import type Database from "better-sqlite3";
import { slugFromPath } from "../agentUserMessages/projectKey.js";
import type { GitCommitRow } from "./collect.js";

export type CommitState = {
  lastHash: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
};

export function getCommitState(
  db: Database.Database,
  repoKey: string
): CommitState | null {
  const r = db
    .prepare(
      `SELECT last_hash AS lastHash, last_run_at AS lastRunAt,
              last_status AS lastStatus, last_error AS lastError
       FROM git_commits_state WHERE repo_key = ?`
    )
    .get(repoKey) as
    | {
        lastHash: string | null;
        lastRunAt: string | null;
        lastStatus: string | null;
        lastError: string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    lastHash: r.lastHash ?? null,
    lastRunAt: r.lastRunAt ?? null,
    lastStatus: r.lastStatus ?? null,
    lastError: r.lastError ?? null,
  };
}

export function setCommitState(
  db: Database.Database,
  repoKey: string,
  state: CommitState
): void {
  db.prepare(
    `INSERT INTO git_commits_state
       (repo_key, last_hash, last_run_at, last_status, last_error)
     VALUES (@repoKey, @lastHash, @lastRunAt, @lastStatus, @lastError)
     ON CONFLICT(repo_key) DO UPDATE SET
        last_hash = excluded.last_hash,
        last_run_at = excluded.last_run_at,
        last_status = excluded.last_status,
        last_error = excluded.last_error`
  ).run({
    repoKey,
    lastHash: state.lastHash,
    lastRunAt: state.lastRunAt,
    lastStatus: state.lastStatus,
    lastError: state.lastError,
  });
}

/** Idempotent upsert of commit rows for one repo. Returns rows written. */
export function upsertCommits(
  db: Database.Database,
  repoKey: string,
  commits: GitCommitRow[],
  nowIso: string = new Date().toISOString()
): number {
  if (commits.length === 0) return 0;
  const projectKey = slugFromPath(repoKey);
  const stmt = db.prepare(
    `INSERT INTO git_commits
       (repo_key, commit_hash, author_date_utc, committer_date_utc, subject,
        added, deleted, files_changed, project_key, ingested_at)
     VALUES
       (@repoKey, @commitHash, @authorDateUtc, @committerDateUtc, @subject,
        @added, @deleted, @filesChanged, @projectKey, @ingestedAt)
     ON CONFLICT(repo_key, commit_hash) DO UPDATE SET
        author_date_utc = excluded.author_date_utc,
        committer_date_utc = excluded.committer_date_utc,
        subject = excluded.subject,
        added = excluded.added,
        deleted = excluded.deleted,
        files_changed = excluded.files_changed,
        project_key = excluded.project_key,
        ingested_at = excluded.ingested_at`
  );
  const tx = db.transaction((rows: GitCommitRow[]) => {
    for (const c of rows) {
      stmt.run({
        repoKey,
        commitHash: c.hash,
        authorDateUtc: c.authorDateUtc,
        committerDateUtc: c.committerDateUtc || null,
        subject: c.subject,
        added: c.added,
        deleted: c.deleted,
        filesChanged: c.filesChanged,
        projectKey,
        ingestedAt: nowIso,
      });
    }
    return rows.length;
  });
  return tx(commits);
}

/** Wipe a repo's commit rows before a full rescan (kills ghost/rewritten rows). */
export function deleteCommitsForRepo(
  db: Database.Database,
  repoKey: string
): void {
  db.prepare("DELETE FROM git_commits WHERE repo_key = ?").run(repoKey);
}
