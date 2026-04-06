import type Database from "better-sqlite3";
import { DEFAULT_MANIFEST_RELS } from "../config.js";
import { discoverGitRepos, readManifestIfPresent } from "../scanner/discover.js";
import {
  finishJob,
  replaceManifest,
  startJob,
  upsertRepo,
} from "../store/operations.js";

export type ScanResult = {
  jobId: number;
  reposFound: number;
  manifestsIndexed: number;
  errors: string[];
};

export function runScan(
  db: Database.Database,
  roots: string[],
  manifestRels: readonly string[] = DEFAULT_MANIFEST_RELS
): ScanResult {
  const errors: string[] = [];
  const jobId = startJob(db, "scan");
  let manifestsIndexed = 0;
  const seenRepos = new Set<string>();

  try {
    for (const root of roots) {
      let repos;
      try {
        repos = discoverGitRepos(root);
      } catch (e) {
        errors.push(`root ${root}: ${String(e)}`);
        continue;
      }
      for (const repo of repos) {
        if (seenRepos.has(repo.rootCanonical)) continue;
        seenRepos.add(repo.rootCanonical);
        const repoId = upsertRepo(
          db,
          repo.rootCanonical,
          repo.originUrl,
          jobId
        );
        for (const rel of manifestRels) {
          const data = readManifestIfPresent(repo.rootCanonical, rel);
          if (!data) continue;
          replaceManifest(db, repoId, {
            rel_path: rel,
            mtime_ms: data.mtime_ms,
            size_bytes: data.size_bytes,
            sha256_hex: null,
            body: data.body,
          });
          manifestsIndexed += 1;
        }
      }
    }
    finishJob(
      db,
      jobId,
      "ok",
      errors.length ? errors.join("; ") : null
    );
    return {
      jobId,
      reposFound: seenRepos.size,
      manifestsIndexed,
      errors,
    };
  } catch (e) {
    finishJob(db, jobId, "error", String(e));
    throw e;
  }
}
