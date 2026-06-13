import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitExecOptions = {
  /** Working directory for the git invocation. */
  cwd: string;
  /** Maximum output buffer size in bytes (default 10MB; raise for large `git log` scans). */
  maxBuffer?: number;
};

export type GitExecAsyncOptions = GitExecOptions & {
  /** AbortSignal to cancel an in-flight async git call. */
  signal?: AbortSignal;
};

/**
 * Synchronous wrapper around `git`. Mirrors the helper previously defined in
 * `src/github/radarInsights/currentWork.ts` so its semantics stay byte-identical
 * for existing callers.
 *
 * Errors propagate as Node's child_process Error (with `status`, `stderr`).
 * stdin/stderr are intentionally suppressed; only stdout is returned.
 */
export function execGitSync(args: string[], options: GitExecOptions): string {
  return execFileSync("git", args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });
}

/**
 * Async git invocation for parallel scanning (e.g. workRecap scanning many
 * repos via `p-limit`). Returns stdout text. Non-zero exit codes throw; the
 * caller is responsible for catching per-repo failures so one bad repo does
 * not poison the batch.
 */
export async function execGit(
  args: string[],
  options: GitExecAsyncOptions
): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    signal: options.signal,
  });
  return result.stdout;
}
