/**
 * Parse `git log --numstat` output into per-day line churn.
 *
 * Expected input shape (produced by the collector with
 * `--pretty=format:%x00%ad --date=format-local:%Y-%m-%d --numstat --no-merges`):
 *
 *   <NUL><sha>\x1f<author-email>\x1f<author-date-iso>\x1f2026-06-20
 *                               <- COMMIT_MARK + 4 unit-separated fields
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

/** Commit-field separator = git `%x1f` (US). `%ae` / sha / ISO date can't contain it. */
export const FIELD_MARK = String.fromCharCode(31);

export type DayChurn = { added: number; deleted: number; commits: number };
export type DenoisePredicate = (path: string) => boolean;

/**
 * One commit's contribution after denoise. `day` is git's `--date=format-local`
 * calendar day and is **stored verbatim** — never recomputed from `authoredAt`,
 * because the two diverge across timezone changes.
 */
export type CommitChurn = {
  sha: string;
  authorEmail: string;
  /** `%aI` normalized to UTC. Raw `%aI` carries the author's local offset and
   *  a TEXT column with mixed offsets can't be string-compared. */
  authoredAt: string;
  day: string;
  added: number;
  deleted: number;
};

/** `%aI` (offset-carrying ISO) → UTC ISO. Unparseable input is returned as-is. */
export function toUtcIso(raw: string): string {
  const t = Date.parse(raw);
  return Number.isNaN(t) ? raw : new Date(t).toISOString();
}

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
): CommitChurn[] {
  const out: CommitChurn[] = [];
  if (!raw) return out;

  // Each commit block starts with COMMIT_MARK. split drops a leading empty chunk.
  for (const block of raw.split(COMMIT_MARK)) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    // Header: <sha>\x1f<author-email>\x1f<%aI>\x1f<local day>
    const head = lines[0].trim().split(FIELD_MARK);
    if (head.length < 4) continue;
    const [sha, authorEmail, authoredRaw, day] = head.map((x) => x.trim());
    if (!sha || !day) continue;

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

    out.push({
      sha,
      authorEmail,
      authoredAt: toUtcIso(authoredRaw),
      day,
      added,
      deleted,
    });
  }

  return out;
}

/**
 * Roll per-commit churn up to the per-day shape v1 stored.
 *
 * Kept as its own function so the rules encoded in the existing parse tests
 * (denoise, rename normalization, binary skip, "commits counts only commits
 * contributing >=1 line") stay asserted verbatim — they are about parsing,
 * not about storage grain.
 */
export function rollupByDay(commits: CommitChurn[]): Map<string, DayChurn> {
  const out = new Map<string, DayChurn>();
  for (const c of commits) {
    const cur = out.get(c.day) ?? { added: 0, deleted: 0, commits: 0 };
    cur.added += c.added;
    cur.deleted += c.deleted;
    cur.commits += 1;
    out.set(c.day, cur);
  }
  return out;
}
