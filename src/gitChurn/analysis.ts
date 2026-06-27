/**
 * Pure join of per-project AI token usage with per-repo git line churn.
 *
 * Output is REPO-level (decision A / Codex P1): a token project_key that is a
 * subdirectory of a repo is aggregated UP to that repo (longest-prefix match),
 * so a monorepo's churn is never double-attributed across sub-projects.
 *
 *   token project_key ──> isAbsolute?
 *      no  -> unmatched.nonPathIdentity   (key is a `${source}:${id}` fallback, not a path)
 *      yes -> longest-prefix among repos
 *               none -> unmatched.noMatchingRepo
 *               R    -> add tokens to repo R
 *   repo R with tokens:
 *      churn present        -> row { ...churn, tokensPerLine = tokens/added (null if added=0) }
 *      no churn + scanned   -> row status "ok" with zero churn (nothing landed)
 *      no churn + !scanned  -> row status "not_scanned" (scheduler hasn't synced — honest, not "no output")
 *   repo with churn but no tokens -> unmatched.gitNoToken
 *
 * tokensPerLine is a labeled "rough efficiency" lens (token / added lines), NOT a
 * value metric — the UI must say so.
 */
import { isAbsolute, sep } from "node:path";

export type RepoChurn = { added: number; deleted: number; commits: number };

export type ProjectOutputRow = {
  repo: string;
  tokens: number;
  added: number;
  deleted: number;
  net: number;
  commits: number;
  /** token / added; null when added == 0 (no divide). */
  tokensPerLine: number | null;
  status: "ok" | "not_scanned";
};

export type ProjectOutputResult = {
  rows: ProjectOutputRow[];
  unmatched: {
    nonPathIdentity: Array<{ key: string; tokens: number }>;
    noMatchingRepo: Array<{ key: string; tokens: number }>;
    gitNoToken: Array<{ repo: string } & RepoChurn>;
  };
};

/** Longest repo path that contains `p` (exact, or a parent dir of `p`). */
function containingRepo(p: string, repos: string[]): string | null {
  let best: string | null = null;
  for (const r of repos) {
    if (p === r || p.startsWith(r.endsWith(sep) ? r : r + sep)) {
      if (best === null || r.length > best.length) best = r;
    }
  }
  return best;
}

export function projectOutputAnalysis(input: {
  /** project_key -> total tokens (Claude + Codex already merged by the caller). */
  tokens: Map<string, number>;
  /** Canonical repo paths (repos.path_canonical). */
  repos: string[];
  /** repo path -> windowed churn. */
  churn: Map<string, RepoChurn>;
  /** repos that the churn scheduler has synced at least once. */
  scannedRepos: Set<string>;
}): ProjectOutputResult {
  const nonPathIdentity: Array<{ key: string; tokens: number }> = [];
  const noMatchingRepo: Array<{ key: string; tokens: number }> = [];
  const tokensByRepo = new Map<string, number>();

  for (const [key, tokens] of input.tokens) {
    if (!isAbsolute(key)) {
      nonPathIdentity.push({ key, tokens });
      continue;
    }
    const repo = containingRepo(key, input.repos);
    if (!repo) {
      noMatchingRepo.push({ key, tokens });
      continue;
    }
    tokensByRepo.set(repo, (tokensByRepo.get(repo) ?? 0) + tokens);
  }

  const rows: ProjectOutputRow[] = [];
  for (const [repo, tokens] of tokensByRepo) {
    const c = input.churn.get(repo);
    if (c) {
      rows.push({
        repo,
        tokens,
        added: c.added,
        deleted: c.deleted,
        net: c.added - c.deleted,
        commits: c.commits,
        tokensPerLine: c.added > 0 ? tokens / c.added : null,
        status: "ok",
      });
    } else {
      // tokens but no churn row: distinguish "scanned, nothing landed" from "never synced".
      const scanned = input.scannedRepos.has(repo);
      rows.push({
        repo,
        tokens,
        added: 0,
        deleted: 0,
        net: 0,
        commits: 0,
        tokensPerLine: null,
        status: scanned ? "ok" : "not_scanned",
      });
    }
  }

  const gitNoToken: Array<{ repo: string } & RepoChurn> = [];
  for (const [repo, c] of input.churn) {
    if (!tokensByRepo.has(repo)) gitNoToken.push({ repo, ...c });
  }

  return { rows, unmatched: { nonPathIdentity, noMatchingRepo, gitNoToken } };
}
