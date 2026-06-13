import pLimit from "p-limit";
import { basename } from "node:path";
import { execGit } from "../git/exec.js";
import {
  COMMIT_TYPE_KINDS,
  WORK_RECAP_CONCURRENCY,
  WORK_RECAP_PER_REPO_COMMIT_CAP,
  WORK_RECAP_SCAN_TIMEOUT_MS,
  type WorkRecapCommit,
  type WorkRecapCommitTypeKind,
  type WorkRecapDiagnostic,
} from "./types.js";

const COMMIT_FIELD_SEP = "\x1f"; // ASCII unit separator
const COMMIT_RECORD_SEP = "\x1e"; // ASCII record separator
// Format: sha \x1f authorEmail \x1f authorName \x1f committedAt \x1f subject
// Records separated by \x1e so subjects containing newlines parse cleanly.
const GIT_LOG_FORMAT = `--format=%H${COMMIT_FIELD_SEP}%aE${COMMIT_FIELD_SEP}%aN${COMMIT_FIELD_SEP}%cI${COMMIT_FIELD_SEP}%s${COMMIT_RECORD_SEP}`;

const CONVENTIONAL_PREFIX_REGEX =
  /^([a-z]+)(?:\([^)]*\))?(!)?:/i;

const PREFIX_KIND_MAP: Record<string, WorkRecapCommitTypeKind> = {
  feat: "feat",
  feature: "feat",
  fix: "fix",
  bugfix: "fix",
  hotfix: "fix",
  refactor: "refactor",
  docs: "docs",
  doc: "docs",
  chore: "chore",
  test: "test",
  tests: "test",
  style: "style",
  perf: "perf",
  performance: "perf",
  build: "build",
  ci: "ci",
  revert: "revert",
};

export function classifyCommitKind(subject: string): WorkRecapCommitTypeKind {
  const trimmed = subject.trim();
  if (trimmed.toLowerCase().startsWith("revert ")) return "revert";
  const match = trimmed.match(CONVENTIONAL_PREFIX_REGEX);
  if (!match) return "other";
  const prefix = match[1].toLowerCase();
  return PREFIX_KIND_MAP[prefix] ?? "other";
}

function deriveRepoLabel(repoPath: string): string {
  // basename gives us the leaf dir; for monorepos that's the project name.
  // Two-level fallback (parent/leaf) is handled at presentation time when
  // multiple repos share a label — the DTO carries projectKey (path) too.
  return basename(repoPath) || repoPath;
}

function parseCommitOutput(
  stdout: string,
  repoPath: string
): WorkRecapCommit[] {
  if (!stdout) return [];
  const out: WorkRecapCommit[] = [];
  const repoLabel = deriveRepoLabel(repoPath);
  const records = stdout.split(COMMIT_RECORD_SEP);
  for (const raw of records) {
    const text = raw.replace(/^\n+/, "");
    if (!text) continue;
    const parts = text.split(COMMIT_FIELD_SEP);
    if (parts.length < 5) continue;
    const [sha, authorEmail, authorName, committedAt, subject] = parts;
    if (!sha || !committedAt || !subject) continue;
    const committed = new Date(committedAt);
    if (Number.isNaN(committed.getTime())) continue;
    out.push({
      repoPath,
      repoLabel,
      sha: sha.trim(),
      authorEmail: authorEmail.trim(),
      authorName: authorName.trim(),
      committedAt: committed,
      subject: subject.trim(),
      kind: classifyCommitKind(subject),
    });
  }
  return out;
}

export type ScanRepoArgs = {
  cwd: string;
  authorEmail: string;
  since: Date;
  signal?: AbortSignal;
  /** Override `--max-count` (default WORK_RECAP_PER_REPO_COMMIT_CAP). */
  maxCount?: number;
};

export type ScanRepoResult = {
  commits: WorkRecapCommit[];
  capHit: boolean;
};

/**
 * Scan a single repo. Throws on non-zero exit (caller catches per-repo).
 *
 * Uses `--use-mailmap` so commits made under prior email aliases still match
 * the current author identity (project learning `git-log-use-mailmap`).
 */
export async function scanSingleRepo(
  args: ScanRepoArgs
): Promise<ScanRepoResult> {
  const maxCount = args.maxCount ?? WORK_RECAP_PER_REPO_COMMIT_CAP;
  const stdout = await execGit(
    [
      "log",
      `--since=${args.since.toISOString()}`,
      `--author=${args.authorEmail}`,
      "--use-mailmap",
      `--max-count=${maxCount}`,
      GIT_LOG_FORMAT,
    ],
    { cwd: args.cwd, signal: args.signal }
  );
  const commits = parseCommitOutput(stdout, args.cwd);
  // capHit: we cannot tell from stdout alone whether more commits existed;
  // the heuristic is "we got the max", which gives a useful upper-bound signal.
  return { commits, capHit: commits.length >= maxCount };
}

export type ScanCommitsArgs = {
  repoPaths: string[];
  authorEmail: string;
  since: Date;
  /** Override total scan timeout (default WORK_RECAP_SCAN_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Override concurrency (default WORK_RECAP_CONCURRENCY). */
  concurrency?: number;
  /** Override per-repo commit cap. */
  perRepoMaxCount?: number;
};

export type ScanCommitsResult = {
  commits: WorkRecapCommit[];
  reposScanned: number;
  reposTotal: number;
  truncated: boolean;
  truncatedReason: "scan_timeout" | null;
  diagnostics: WorkRecapDiagnostic[];
};

/**
 * Scan all repos in parallel with concurrency cap. Returns partial results
 * when the global timeout fires (F8 / F9 decisions). Each repo failure is
 * captured as a diagnostic and does not poison the batch (other repos
 * continue).
 */
export async function scanCommits(
  args: ScanCommitsArgs
): Promise<ScanCommitsResult> {
  const reposTotal = args.repoPaths.length;
  if (reposTotal === 0) {
    return {
      commits: [],
      reposScanned: 0,
      reposTotal: 0,
      truncated: false,
      truncatedReason: null,
      diagnostics: [],
    };
  }

  const limit = pLimit(args.concurrency ?? WORK_RECAP_CONCURRENCY);
  const controller = new AbortController();
  const diagnostics: WorkRecapDiagnostic[] = [];
  const commits: WorkRecapCommit[] = [];
  let reposScanned = 0;
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, args.timeoutMs ?? WORK_RECAP_SCAN_TIMEOUT_MS);

  try {
    await Promise.all(
      args.repoPaths.map((cwd) =>
        limit(async () => {
          if (controller.signal.aborted) return;
          try {
            const { commits: rc, capHit } = await scanSingleRepo({
              cwd,
              authorEmail: args.authorEmail,
              since: args.since,
              signal: controller.signal,
              maxCount: args.perRepoMaxCount,
            });
            if (controller.signal.aborted) return;
            commits.push(...rc);
            reposScanned += 1;
            if (capHit) {
              diagnostics.push({
                severity: "warning",
                kind: "commit_cap_hit",
                message: `repo hit per-repo commit cap (${args.perRepoMaxCount ?? WORK_RECAP_PER_REPO_COMMIT_CAP})`,
                repo: cwd,
              });
            }
          } catch (e) {
            if (controller.signal.aborted) return;
            const message = e instanceof Error ? e.message : String(e);
            diagnostics.push({
              severity: "warning",
              kind: "git_log_failed",
              message,
              repo: cwd,
            });
          }
        })
      )
    );
  } finally {
    clearTimeout(timeout);
  }

  if (timedOut) {
    diagnostics.push({
      severity: "warning",
      kind: "scan_timeout",
      message: `scan timed out after ${args.timeoutMs ?? WORK_RECAP_SCAN_TIMEOUT_MS}ms; ${reposScanned}/${reposTotal} repos scanned`,
    });
  }

  return {
    commits,
    reposScanned,
    reposTotal,
    truncated: timedOut,
    truncatedReason: timedOut ? "scan_timeout" : null,
    diagnostics,
  };
}

/** Exposed for tests so they don't have to know prefix-regex internals. */
export const __testing = {
  parseCommitOutput,
  COMMIT_FIELD_SEP,
  COMMIT_RECORD_SEP,
  GIT_LOG_FORMAT,
};

/** Re-export for test convenience. */
export { COMMIT_TYPE_KINDS };
