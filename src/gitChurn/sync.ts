/**
 * Batch git-churn sync for the scheduler task `git.line_churn.sync`.
 *
 * Walks every scanned repo (`repos.path_canonical`), resolves the global git
 * author, and runs {@link collectRepoChurn} per repo with bounded concurrency and
 * per-repo isolation (one bad repo does not poison the batch — mirrors
 * `workRecap/scan.ts`).
 */
import type Database from "better-sqlite3";
import pLimit from "p-limit";
import { resolveGlobalAuthorEmail } from "../workRecap/service.js";
import { collectRepoChurn } from "./collect.js";

/** Lower bound for a (re)scan. Generous so first runs still capture recent history. */
const DEFAULT_FLOOR_DAYS = 400;
const CONCURRENCY = 4;

export type ChurnSyncResult = {
  status: "success" | "partial" | "failed";
  reposTotal: number;
  reposOk: number;
  reposFailed: number;
  authorEmail: string | null;
  errors: string[];
};

export async function syncAllReposChurn(
  db: Database.Database,
  opts: { floorDays?: number; nowIso?: string } = {}
): Promise<ChurnSyncResult> {
  const authorEmail = resolveGlobalAuthorEmail();
  if (!authorEmail) {
    return {
      status: "failed",
      reposTotal: 0,
      reposOk: 0,
      reposFailed: 0,
      authorEmail: null,
      errors: ["no global git author email (git config --global user.email)"],
    };
  }

  const repos = (
    db.prepare("SELECT path_canonical FROM repos WHERE missing_since IS NULL").all() as Array<{
      path_canonical: string;
    }>
  ).map((r) => r.path_canonical);

  if (repos.length === 0) {
    return { status: "success", reposTotal: 0, reposOk: 0, reposFailed: 0, authorEmail, errors: [] };
  }

  const floorDays = opts.floorDays ?? DEFAULT_FLOOR_DAYS;
  const floorSince = new Date(Date.now() - floorDays * 86_400_000);

  const limit = pLimit(CONCURRENCY);
  const errors: string[] = [];
  let reposOk = 0;
  let reposFailed = 0;

  await Promise.all(
    repos.map((repoPath) =>
      limit(async () => {
        try {
          await collectRepoChurn(db, { repoPath, authorEmail, floorSince, nowIso: opts.nowIso });
          reposOk++;
        } catch (e) {
          reposFailed++;
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`${repoPath}: ${msg}`);
        }
      })
    )
  );

  const status = reposFailed === 0 ? "success" : reposOk === 0 ? "failed" : "partial";
  return { status, reposTotal: repos.length, reposOk, reposFailed, authorEmail, errors };
}
