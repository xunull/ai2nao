import type Database from "better-sqlite3";
import { DEFAULT_PROJECT_CONTEXT } from "../config.js";
import {
  discoverGitRepos,
  listMarkdownDocs,
  readManifestIfPresent,
} from "../scanner/discover.js";
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
  /** Docs intentionally NOT indexed because a repo hit the per-repo doc cap or a
   *  doc exceeded the byte limit. Benign/by-design — NOT an error. */
  cappedDocs: number;
  errors: string[];
};

export function runScan(
  db: Database.Database,
  roots: string[],
  manifestRels: readonly string[] = DEFAULT_PROJECT_CONTEXT.fixedManifestRels,
  opts: { maxDepth?: number; maxDocs?: number } = {}
): ScanResult {
  const errors: string[] = [];
  const jobId = startJob(db, "scan");
  let manifestsIndexed = 0;
  let cappedDocs = 0;
  const seenRepos = new Set<string>();
  const maxDocs = opts.maxDocs ?? DEFAULT_PROJECT_CONTEXT.maxDocsPerRepo;

  try {
    for (const root of roots) {
      let repos;
      try {
        repos = discoverGitRepos(root, { maxDepth: opts.maxDepth });
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
        const markdownDocs = listMarkdownDocs(repo.rootCanonical, DEFAULT_PROJECT_CONTEXT.docsRootRel, {
          maxDocs,
          maxDocBytes: DEFAULT_PROJECT_CONTEXT.maxDocBytes,
        });
        // Hitting the per-repo doc cap / byte limit is expected and benign — it
        // must NOT push the scan to `partial`. Surface it as a count in the
        // summary instead. Only real failures (a root that throws) go to errors.
        cappedDocs += markdownDocs.skipped;
        for (const rel of markdownDocs.docs) {
          if (manifestRels.includes(rel)) continue;
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
      cappedDocs,
      errors,
    };
  } catch (e) {
    finishJob(db, jobId, "error", String(e));
    throw e;
  }
}
