/**
 * Parse `git log --numstat` output into per-day line churn.
 *
 * Expected input shape (produced by the collector with
 * `--pretty=format:%x00%ad --date=format-local:%Y-%m-%d --numstat --no-merges`):
 *
 *   <NUL>2026-06-20            <- COMMIT_MARK + author-date (local calendar day)
 *   10  2   src/a.ts          <- numstat: added\tdeleted\tpath
 *   -   -   img.png           <- binary file (skip line counts)
 *   ...
 *   <NUL>2026-06-21
 *   ...
 *
 * Rules (locked in /plan-eng-review):
 *  - binary files (`-` added/deleted) contribute no lines.
 *  - rename paths (`dir/{old => new}/f`, `{a => b}`, `a => b`) are normalized to
 *    the NEW path BEFORE the denoise check, so `dist/{a => b}.js` is still denoised.
 *  - a file matching {@link DenoisePredicate} is excluded from line counts.
 *  - `commits` counts only commits that contribute >=1 line after denoise (a commit
 *    touching only lock/dist files is not counted), so it aligns with the shown
 *    added/deleted.
 */

/** Commit-boundary marker = git `%x00` (NUL). Kept as a JS escape (ASCII source). */
export const COMMIT_MARK = String.fromCharCode(0);

export type DayChurn = { added: number; deleted: number; commits: number };
export type DenoisePredicate = (path: string) => boolean;

/**
 * Normalize a numstat path that may encode a rename to its NEW path:
 *   "dir/{old => new}/f" -> "dir/new/f"
 *   "{a => b}"           -> "b"
 *   "a => b"             -> "b"
 */
export function normalizeRenamePath(path: string): string {
  // Brace form: replace each "{x => y}" with "y".
  let out = path.replace(/\{[^{}]*? => ([^{}]*?)\}/g, "$1");
  // Bare form (whole path is "a => b"): take the right side.
  const bare = out.match(/^.+ => (.+)$/);
  if (bare) out = bare[1];
  // Collapse any accidental double slashes from an empty rename segment.
  return out.replace(/\/{2,}/g, "/");
}

const DEFAULT_DENOISE_PATTERNS: RegExp[] = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /\.lock$/, // Cargo.lock, *.lock
  /\.min\.(js|css)$/,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
];

/** v1 hardcoded denoise: generated / vendored files that inflate churn. */
export const defaultDenoise: DenoisePredicate = (path) =>
  DEFAULT_DENOISE_PATTERNS.some((re) => re.test(path));

export function parseNumstat(
  raw: string,
  opts: { isDenoised: DenoisePredicate }
): Map<string, DayChurn> {
  const out = new Map<string, DayChurn>();
  if (!raw) return out;

  // Each commit block starts with COMMIT_MARK. split drops a leading empty chunk.
  for (const block of raw.split(COMMIT_MARK)) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const day = lines[0].trim();
    if (!day) continue;

    let added = 0;
    let deleted = 0;
    let contributed = false;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
      if (!m) continue;
      const [, a, d, rawPath] = m;
      if (a === "-" || d === "-") continue; // binary: no line counts
      const path = normalizeRenamePath(rawPath);
      if (opts.isDenoised(path)) continue;
      added += Number(a);
      deleted += Number(d);
      contributed = true;
    }
    if (!contributed) continue; // commit touched only denoised/binary files

    const cur = out.get(day) ?? { added: 0, deleted: 0, commits: 0 };
    cur.added += added;
    cur.deleted += deleted;
    cur.commits += 1;
    out.set(day, cur);
  }

  return out;
}
