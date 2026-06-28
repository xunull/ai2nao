import { readdir, stat, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { LimitFunction } from "p-limit";
import { DEFAULT_EXCLUDE_DIR_NAMES } from "../config.js";
import { readOriginUrl } from "../git/parseConfig.js";
import { canonicalizePath } from "../path/canonical.js";

export type DiscoveredRepo = {
  rootCanonical: string;
  originUrl: string | null;
};

function shouldSkipDir(name: string, excludeNames: Set<string>): boolean {
  return excludeNames.has(name);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Parallel bounded walk from `root`; resolves to every git repository root
 * (directory containing `.git/`).
 *
 * I/O (readdir) is funnelled through the SHARED `limit` so the whole scan — all
 * roots + every nested dir — obeys one global concurrency cap (no EMFILE, no
 * per-root limiter). The walk is a bounded work queue (an `active` counter, not
 * an unbounded recursive `Promise.all`): each found dir schedules its children
 * and the walk resolves when no dir is outstanding.
 *
 * `maxDepth` bounds levels below the root (root = depth 0); we check the current
 * dir for `.git` always, but recurse only while `depth < maxDepth`. `realpath`
 * (canonicalizePath) and `.git/config` read stay synchronous by design — they
 * are tiny per-repo and run inside the limited task.
 */
export function discoverGitRepos(
  root: string,
  options: { excludeDirNames?: Set<string>; maxDepth?: number; limit: LimitFunction }
): Promise<DiscoveredRepo[]> {
  const excludeNames = options.excludeDirNames ?? DEFAULT_EXCLUDE_DIR_NAMES;
  const maxDepth = options.maxDepth ?? Infinity;
  const limit = options.limit;
  const base = canonicalizePath(root);
  if (!base) return Promise.resolve([]);

  return new Promise<DiscoveredRepo[]>((resolve) => {
    const out: DiscoveredRepo[] = [];
    const seen = new Set<string>();
    let active = 0;

    function schedule(dir: string, depth: number): void {
      active += 1;
      limit(() => readdir(dir, { withFileTypes: true }))
        .then((entries) => {
          const hasGit = entries.some((e) => e.name === ".git" && e.isDirectory());
          if (hasGit) {
            const canon = canonicalizePath(dir);
            if (canon && !seen.has(canon)) {
              seen.add(canon);
              out.push({ rootCanonical: canon, originUrl: readOriginUrl(dir) });
            }
            return; // a repo root: do not descend into it
          }
          if (depth >= maxDepth) return;
          for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            if (ent.name === ".git") continue;
            if (shouldSkipDir(ent.name, excludeNames)) continue;
            schedule(join(dir, ent.name), depth + 1);
          }
        })
        .catch(() => {
          // dir vanished / unreadable mid-walk -> ignore it, keep scanning others.
        })
        .finally(() => {
          active -= 1;
          if (active === 0) resolve(out);
        });
    }

    // Guard: base must be an existing directory, else empty.
    limit(() => isDirectory(base))
      .then((ok) => {
        if (!ok) {
          resolve(out);
          return;
        }
        schedule(base, 0);
      })
      .catch(() => resolve(out));
  });
}

export async function readManifestIfPresent(
  repoRoot: string,
  relPath: string,
  limit: LimitFunction
): Promise<{ mtime_ms: number; size_bytes: number; body: string } | null> {
  const abs = join(repoRoot, relPath);
  return limit(async () => {
    let st;
    try {
      st = await stat(abs);
    } catch {
      return null; // missing / unreadable
    }
    if (!st.isFile()) return null;
    let body: string;
    try {
      body = await readFile(abs, "utf8");
    } catch {
      return null;
    }
    return { mtime_ms: Math.trunc(st.mtimeMs), size_bytes: st.size, body };
  });
}

export type MarkdownDocScanResult = {
  docs: string[];
  skipped: number;
};

/**
 * List markdown docs under `docsRootRel`, capped at `maxDocs` and `maxDocBytes`.
 * Candidates are collected (parallel readdir/stat via `limit`) then SORTED by
 * relative path before the cap is applied — so concurrency does not change which
 * docs survive (deterministic: concurrency=1 and =16 pick the same set).
 */
export async function listMarkdownDocs(
  repoRoot: string,
  docsRootRel: string,
  options: {
    maxDocs: number;
    maxDocBytes: number;
    excludeDirNames?: Set<string>;
    limit: LimitFunction;
  }
): Promise<MarkdownDocScanResult> {
  const excludeNames = options.excludeDirNames ?? DEFAULT_EXCLUDE_DIR_NAMES;
  const limit = options.limit;
  const docsRoot = join(repoRoot, docsRootRel);
  if (!(await limit(() => isDirectory(docsRoot)))) return { docs: [], skipped: 0 };

  const candidates: { rel: string; size: number }[] = [];
  let skipped = 0;

  await new Promise<void>((resolve) => {
    let active = 0;
    function schedule(dir: string): void {
      active += 1;
      limit(() => readdir(dir, { withFileTypes: true }))
        .then(async (entries) => {
          const fileWork: Promise<void>[] = [];
          for (const ent of entries) {
            if (ent.isDirectory()) {
              if (!shouldSkipDir(ent.name, excludeNames)) schedule(join(dir, ent.name));
              continue;
            }
            if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
            const abs = join(dir, ent.name);
            fileWork.push(
              limit(() => stat(abs))
                .then((st) => {
                  candidates.push({ rel: relative(repoRoot, abs), size: st.size });
                })
                .catch(() => {
                  skipped += 1; // stat failed
                })
            );
          }
          await Promise.all(fileWork);
        })
        .catch(() => {
          skipped += 1; // dir unreadable
        })
        .finally(() => {
          active -= 1;
          if (active === 0) resolve();
        });
    }
    schedule(docsRoot);
  });

  // Deterministic: sort, then apply the byte + count caps in stable order.
  candidates.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const docs: string[] = [];
  for (const c of candidates) {
    if (c.size > options.maxDocBytes) {
      skipped += 1;
      continue;
    }
    if (docs.length >= options.maxDocs) {
      skipped += 1;
      continue;
    }
    docs.push(c.rel);
  }
  return { docs, skipped };
}
