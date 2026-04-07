import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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
