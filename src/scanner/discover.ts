import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
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

/**
 * Depth-first walk from `root`; yields each git repository root (directory containing `.git/`).
 */
export function discoverGitRepos(
  root: string,
  options?: { excludeDirNames?: Set<string> }
): DiscoveredRepo[] {
  const excludeNames = options?.excludeDirNames ?? DEFAULT_EXCLUDE_DIR_NAMES;
  const base = canonicalizePath(root);
  if (!base || !existsSync(base)) return [];
  const seen = new Set<string>();
  const out: DiscoveredRepo[] = [];

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === ".git" && ent.isDirectory()) {
        const canon = canonicalizePath(dir);
        if (!canon) {
          return;
        }
        if (!seen.has(canon)) {
          seen.add(canon);
          out.push({
            rootCanonical: canon,
            originUrl: readOriginUrl(dir),
          });
        }
        return;
      }
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name === ".git") continue;
      if (shouldSkipDir(ent.name, excludeNames)) continue;
      walk(join(dir, ent.name));
    }
  }

  walk(base);
  return out;
}

export function readManifestIfPresent(
  repoRoot: string,
  relPath: string
): { mtime_ms: number; size_bytes: number; body: string } | null {
  const abs = join(repoRoot, relPath);
  if (!existsSync(abs)) return null;
  let st;
  try {
    st = statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  let body: string;
  try {
    body = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  return {
    mtime_ms: Math.trunc(st.mtimeMs),
    size_bytes: st.size,
    body,
  };
}

export type MarkdownDocScanResult = {
  docs: string[];
  skipped: number;
};

export function listMarkdownDocs(
  repoRoot: string,
  docsRootRel: string,
  options: {
    maxDocs: number;
    maxDocBytes: number;
    excludeDirNames?: Set<string>;
  }
): MarkdownDocScanResult {
  const excludeNames = options.excludeDirNames ?? DEFAULT_EXCLUDE_DIR_NAMES;
  const docsRoot = join(repoRoot, docsRootRel);
  if (!existsSync(docsRoot)) return { docs: [], skipped: 0 };
  const docs: string[] = [];
  let skipped = 0;
  const stack = [docsRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped++;
      continue;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (!shouldSkipDir(ent.name, excludeNames)) stack.push(join(dir, ent.name));
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
      const abs = join(dir, ent.name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        skipped++;
        continue;
      }
      if (st.size > options.maxDocBytes) {
        skipped++;
        continue;
      }
      if (docs.length >= options.maxDocs) {
        skipped++;
        continue;
      }
      docs.push(relative(repoRoot, abs));
    }
  }
  return { docs: docs.sort(), skipped };
}
