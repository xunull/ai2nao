import { statSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * Decode Claude Code `~/.claude/projects/<dir>` folder names into absolute paths.
 *
 * Observed encoding (Claude Code): take an absolute POSIX path, drop the leading `/`,
 * then replace every `/` with `-`. The projects entry is often stored with a leading `-`
 * so the string still “starts like” the original path (`-Users-...` ≈ `/Users/...`).
 *
 * Decoding is **not** uniquely determined by the string alone when segment names contain
 * hyphens (the same character used as separator). We recover the path by:
 *
 * 1. Only allowing cuts **on hyphen boundaries** (segment ends at `-` or end of string).
 * 2. **Greedy shortest prefix** on those boundaries: from the remainder, try candidate
 *    segment lengths in **ascending** order; pick the first segment `s` where
 *    `join(currentPath, s)` passes `existsDir` (must be a directory).
 * 3. If nothing matches, stop and report failure / partial result for callers to fall back
 *    to the raw slug.
 *
 * **Limitation:** If an incorrect shorter prefix happens to exist on disk (e.g. a stray
 * `/Users/you/xunull` directory), the shortest-match rule may lock onto it. This matches
 * “best effort on the user’s machine,” not cryptographic decoding.
 *
 * Inject `existsDir` for tests; on the server use {@link directoryExistsSync}.
 */

/** Hyphen positions that are allowed segment boundaries (after encoder's `/` → `-`). */
export function hyphenBoundaryPrefixLengths(rest: string): number[] {
  const lengths: number[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "-") {
      lengths.push(i);
    }
  }
  lengths.push(rest.length);
  const uniq = [...new Set(lengths)].filter((n) => n > 0);
  uniq.sort((a, b) => a - b);
  return uniq;
}

export type DecodeProjectSlugResult = {
  /** Absolute path when fully decoded and verified */
  path: string | null;
  /** Segments after resolving from root (e.g. Users, quincy, xunull-repository, …) */
  segments: string[];
  /** True when decoding stopped early (no boundary matched `existsDir`) */
  incomplete: boolean;
  /** Remaining suffix of the slug body that was not consumed */
  restSuffix: string;
};

/**
 * Strip the optional leading `-` that Claude uses for absolute paths.
 */
export function stripLeadingProjectsDash(slug: string): string {
  const t = slug.trim();
  if (t.startsWith("-")) return t.slice(1);
  return t;
}

/**
 * Core decoder: uses only hyphen-boundary segments and `existsDir` to disambiguate.
 *
 * @param slug Directory name under `~/.claude/projects` (e.g. `-Users-quincy-...`)
 * @param existsDir Return true iff `absPath` exists and is a directory (or symlink to dir)
 * @param root Absolute root to resolve from; default `"/"` for macOS/Linux Claude paths
 */
export function decodeProjectSlugToPath(
  slug: string,
  existsDir: (absPath: string) => boolean,
  root: string = sep === "\\" ? "C:\\" : "/"
): DecodeProjectSlugResult {
  const body = stripLeadingProjectsDash(slug);
  if (!body) {
    return { path: null, segments: [], incomplete: true, restSuffix: "" };
  }

  let rest = body;
  const segments: string[] = [];
  let currentAbs = resolve(root);

  while (rest.length > 0) {
    const lengths = hyphenBoundaryPrefixLengths(rest);
    let advanced = false;
    for (const len of lengths) {
      const seg = rest.slice(0, len);
      if (!seg) continue;
      const candidate = resolve(currentAbs, seg);
      if (existsDir(candidate)) {
        segments.push(seg);
        currentAbs = candidate;
        rest = len < rest.length ? rest.slice(len + 1) : "";
        advanced = true;
        break;
      }
    }
    if (!advanced) {
      return {
        path: segments.length > 0 ? currentAbs : null,
        segments,
        incomplete: true,
        restSuffix: rest,
      };
    }
  }

  return {
    path: currentAbs,
    segments,
    incomplete: false,
    restSuffix: "",
  };
}

export function directoryExistsSync(absPath: string): boolean {
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/** Convenience: decode using the local filesystem (directories must exist). */
export function decodeClaudeProjectDirName(slug: string): DecodeProjectSlugResult {
  return decodeProjectSlugToPath(slug, directoryExistsSync);
}
