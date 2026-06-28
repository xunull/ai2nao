import type Database from "better-sqlite3";
import pLimit from "p-limit";
import { DEFAULT_PROJECT_CONTEXT } from "../config.js";
import { DEFAULT_SCAN_CONCURRENCY } from "../appConfig/index.js";
import {
  discoverGitRepos,
  listMarkdownDocs,
  readManifestIfPresent,
  type DiscoveredRepo,
} from "../scanner/discover.js";
import {
  finishJob,
  reconcileMissingRepos,
  replaceManifest,
  startJob,
  upsertRepo,
} from "../store/operations.js";
import { canonicalizePath } from "../path/canonical.js";

export type ScanResult = {
  jobId: number;
  reposFound: number;
  manifestsIndexed: number;
  /** Docs intentionally NOT indexed because a repo hit the per-repo doc cap or a
   *  doc exceeded the byte limit. Benign/by-design — NOT an error. */
  cappedDocs: number;
  errors: string[];
};

export type RunScanOptions = {
  maxDepth?: number;
  maxDocs?: number;
  concurrency?: number;
};

/**
 * In-process scan mutex. Going async means two `runScan()` calls in the same
 * process could otherwise interleave their DB writes (the old sync version
 * physically could not). Chaining serializes them: a second scan waits for the
 * first. (The scheduler also locks the repos.scan task per key; the CLI is a
 * separate process, guarded at the sqlite layer.)
 */
let scanChain: Promise<unknown> = Promise.resolve();

export function runScan(
  db: Database.Database,
  roots: string[],
  manifestRels: readonly string[] = DEFAULT_PROJECT_CONTEXT.fixedManifestRels,
  opts: RunScanOptions = {}
): Promise<ScanResult> {
  const run = scanChain.then(() => doRunScan(db, roots, manifestRels, opts));
  // Keep the chain alive even if this scan rejects, so the next scan still runs.
  scanChain = run.catch(() => undefined);
  return run;
}

async function doRunScan(
  db: Database.Database,
  roots: string[],
  manifestRels: readonly string[],
  opts: RunScanOptions
): Promise<ScanResult> {
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_SCAN_CONCURRENCY);
  const maxDocs = opts.maxDocs ?? DEFAULT_PROJECT_CONTEXT.maxDocsPerRepo;
  // ioLimit caps concurrent leaf I/O (readdir/stat/readFile) across the whole scan.
  // repoLimit caps how many repos are processed (read+write) at once — bounds memory
  // (only `concurrency` repos hold their file contents). Two limiters, NOT one: a
  // single limiter wrapping both levels would deadlock (a repo task holding a slot
  // while awaiting an inner read that needs a slot).
  const ioLimit = pLimit(concurrency);
  const repoLimit = pLimit(concurrency);

  const errors: string[] = [];
  let manifestsIndexed = 0;
  let cappedDocs = 0;
  const seenRepoIds = new Set<number>();
  const jobId = startJob(db, "scan");

  try {
    // Phase 1 — discover all roots in parallel (shared ioLimit), per-root errors.
    const perRoot = await Promise.all(
      roots.map(async (root) => {
        try {
          return await discoverGitRepos(root, { maxDepth: opts.maxDepth, limit: ioLimit });
        } catch (e) {
          errors.push(`root ${root}: ${String(e)}`);
          return [] as DiscoveredRepo[];
        }
      })
    );

    // Dedup by canonical path BEFORE any read/write, then sort for determinism.
    const byPath = new Map<string, DiscoveredRepo>();
    for (const repo of perRoot.flat()) {
      if (!byPath.has(repo.rootCanonical)) byPath.set(repo.rootCanonical, repo);
    }
    const repos = [...byPath.values()].sort((a, b) =>
      a.rootCanonical < b.rootCanonical ? -1 : a.rootCanonical > b.rootCanonical ? 1 : 0
    );

    // Phase 2 — process each repo (bounded by repoLimit). Reads are async (ioLimit);
    // the write is one sync per-repo transaction. File-read failures degrade to
    // partial; a DB write failure THROWS and aborts the whole scan (never swallowed).
    await Promise.all(
      repos.map((repo) =>
        repoLimit(async () => {
          const files: { rel: string; mtime_ms: number; size_bytes: number; body: string }[] = [];
          for (const rel of manifestRels) {
            const data = await readManifestIfPresent(repo.rootCanonical, rel, ioLimit);
            if (data) files.push({ rel, ...data });
          }
          let markdown;
          try {
            markdown = await listMarkdownDocs(repo.rootCanonical, DEFAULT_PROJECT_CONTEXT.docsRootRel, {
              maxDocs,
              maxDocBytes: DEFAULT_PROJECT_CONTEXT.maxDocBytes,
              limit: ioLimit,
            });
          } catch (e) {
            errors.push(`repo ${repo.rootCanonical}: docs scan failed: ${String(e)}`);
            markdown = { docs: [] as string[], skipped: 0 };
          }
          for (const rel of markdown.docs) {
            if (manifestRels.includes(rel)) continue;
            const data = await readManifestIfPresent(repo.rootCanonical, rel, ioLimit);
            if (data) files.push({ rel, ...data });
          }

          // Sync write — one transaction per repo (upsert + all manifests). DB errors
          // propagate (NOT caught) so disk-full / constraint / FTS failures abort.
          const repoId = db.transaction(() => {
            const id = upsertRepo(db, repo.rootCanonical, repo.originUrl, jobId);
            for (const f of files) {
              replaceManifest(db, id, {
                rel_path: f.rel,
                mtime_ms: f.mtime_ms,
                size_bytes: f.size_bytes,
                sha256_hex: null,
                body: f.body,
              });
            }
            return id;
          })();

          // Aggregate (sync, no await between -> atomic on the single JS thread).
          seenRepoIds.add(repoId);
          manifestsIndexed += files.length;
          cappedDocs += markdown.skipped;
        })
      )
    );

    // Reconcile (mark deleted repos missing) + finishJob in ONE transaction: a
    // reconcile failure must abort the job, never leave "job ok + half-pruned".
    const scannedRoots = roots
      .map((r) => canonicalizePath(r))
      .filter((p): p is string => p !== null);
    const foundPaths = repos.map((r) => r.rootCanonical);
    const nowIso = new Date().toISOString();
    db.transaction(() => {
      reconcileMissingRepos(db, { scannedRoots, seenRepoIds, foundPaths, nowIso });
      finishJob(db, jobId, "ok", errors.length ? errors.sort().join("; ") : null);
    })();
    return {
      jobId,
      reposFound: repos.length,
      manifestsIndexed,
      cappedDocs,
      errors: errors.sort(),
    };
  } catch (e) {
    finishJob(db, jobId, "error", String(e));
    throw e;
  }
}
