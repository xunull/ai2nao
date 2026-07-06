/**
 * Collect the git author's non-merge commits (hash + dates + subject + numstat
 * totals) for the conversation↔commit bridge (T1a).
 *
 * Mirrors gitChurn/collect.ts:
 *  - git invoked via execFile with an ARG ARRAY only (no shell interpolation of
 *    paths), NUL (%x00) record separator, --numstat, --no-merges, --author.
 *  - numstat parse follows parseNumstat.ts: binary files show '-' and add 0.
 *
 * Header layout per commit (`--pretty=format:%x00%H%x1f%aI%x1f%cI%x1f%s`):
 *   <NUL><hash><US><authorDateISO><US><committerDateISO><US><subject>
 * then numstat lines until the next <NUL>. %x1f (unit separator) can't appear in
 * hashes/ISO-dates and is vanishingly unlikely in subjects; %s is last so any
 * trailing content is bounded by the next record's %x00. %aI/%cI are strict ISO.
 */
import { execGit } from "../git/exec.js";

/** Record boundary = git `%x00` (NUL). Kept as an ASCII escape (ASCII source). */
const RECORD_SEP = "\x00";
/** Field separator = git `%x1f` (US) between the 4 header fields. */
const FIELD_SEP = "\x1f";
const PRETTY = "--pretty=format:%x00%H%x1f%aI%x1f%cI%x1f%s";
const NUMSTAT_MAX_BUFFER = 64 * 1024 * 1024; // large repos' numstat can exceed the 10MB default
/** Bounded lower window for a full (re)scan when there is no reachable last_hash. */
const DEFAULT_SINCE_DAYS = 180;

export type GitCommitRow = {
  hash: string;
  authorDateUtc: string;
  committerDateUtc: string;
  subject: string;
  added: number;
  deleted: number;
  filesChanged: number;
};

export type CollectResult = {
  commits: GitCommitRow[];
  mode: "incremental" | "rescan";
};

/**
 * Thrown by the incremental path when `sinceHash..HEAD` fails (e.g. the hash is
 * no longer reachable after a rebase/force-push). Signals the caller to wipe the
 * repo's rows and re-run a bounded full rescan.
 */
export class GitCommitsRescanNeeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitCommitsRescanNeeded";
  }
}

/** Convert a strict ISO-8601 date (with offset) to canonical UTC ISO. */
function toUtcIso(x: string | undefined): string {
  if (!x) return "";
  const d = new Date(x.trim());
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

/**
 * Parse `git log --numstat` output into per-commit rows. Robust like
 * parseNumstat.ts: skips blank lines, tolerates binary ('-') files (0 lines),
 * and counts every touched file toward files_changed.
 */
export function parseCommitRecords(raw: string): GitCommitRow[] {
  const out: GitCommitRow[] = [];
  if (!raw) return out;

  // Each commit block starts with RECORD_SEP. split drops a leading empty chunk.
  for (const block of raw.split(RECORD_SEP)) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const parts = lines[0].split(FIELD_SEP);
    if (parts.length < 4) continue;
    const [hash, authorIso, committerIso, subject] = parts;
    if (!hash.trim()) continue;

    let added = 0;
    let deleted = 0;
    let filesChanged = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
      if (!m) continue;
      const [, a, d] = m;
      if (a !== "-") added += Number(a); // binary: no line counts
      if (d !== "-") deleted += Number(d);
      filesChanged += 1; // a binary file is still a changed file
    }

    out.push({
      hash: hash.trim(),
      authorDateUtc: toUtcIso(authorIso),
      committerDateUtc: toUtcIso(committerIso),
      subject: subject ?? "",
      added,
      deleted,
      filesChanged,
    });
  }

  return out;
}

/**
 * Collect a repo's non-merge commits authored by `authorEmail`.
 *
 *  - incremental: `sinceHash..HEAD` when opts.sinceHash is set. If the git call
 *    fails, throws {@link GitCommitsRescanNeeded} so the caller can wipe + rescan.
 *  - rescan: `--since=<sinceDays>.days` (bounded) when no sinceHash is given.
 */
export async function collectGitCommits(
  repoPath: string,
  opts: { authorEmail: string; sinceHash?: string; sinceDays?: number }
): Promise<CollectResult> {
  const incremental = Boolean(opts.sinceHash);
  const range = incremental
    ? [`${opts.sinceHash}..HEAD`]
    : [`--since=${opts.sinceDays ?? DEFAULT_SINCE_DAYS}.days`];

  let stdout: string;
  try {
    stdout = await execGit(
      [
        "log",
        "--numstat",
        "--no-merges",
        `--author=${opts.authorEmail}`,
        PRETTY,
        ...range,
      ],
      { cwd: repoPath, maxBuffer: NUMSTAT_MAX_BUFFER }
    );
  } catch (e) {
    if (incremental) {
      // last_hash no longer reachable (rebase / force-push / history rewrite):
      // signal the caller to delete + full rescan instead of losing ground.
      const msg = e instanceof Error ? e.message : String(e);
      throw new GitCommitsRescanNeeded(msg);
    }
    throw e; // full-scan failure is a real error (non-git dir, corruption, ...)
  }

  return {
    commits: parseCommitRecords(stdout),
    mode: incremental ? "incremental" : "rescan",
  };
}
