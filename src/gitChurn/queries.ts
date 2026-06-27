/**
 * DB-backed wiring for the project token-vs-output analysis: read windowed token
 * usage (Claude per-session + Codex via the per-event table) and windowed git
 * churn, then delegate the join/bucketing to the pure {@link projectOutputAnalysis}.
 *
 * Codex tokens come from `codex_token_usage_event` (event_at) joined to
 * `codex_session_token_usage` for `project_key` — this avoids the multi-day
 * session collapse that per-session `last_updated_at` would re-introduce.
 */
import type Database from "better-sqlite3";
import { projectOutputAnalysis, type ProjectOutputResult, type RepoChurn } from "./analysis.js";
import { localDay } from "./collect.js";

function mergeTokens(
  claude: Array<{ project_key: string; tokens: number }>,
  codex: Array<{ project_key: string; tokens: number }>
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of claude) m.set(r.project_key, (m.get(r.project_key) ?? 0) + r.tokens);
  for (const r of codex) m.set(r.project_key, (m.get(r.project_key) ?? 0) + r.tokens);
  return m;
}

export function buildProjectOutput(
  db: Database.Database,
  window: { from: Date; to: Date }
): ProjectOutputResult {
  const fromIso = window.from.toISOString();
  const toIso = window.to.toISOString();
  const fromDay = localDay(window.from);
  const toDay = localDay(window.to);

  const claude = db
    .prepare(
      `SELECT project_key, COALESCE(SUM(total_tokens), 0) AS tokens
       FROM claude_session_token_usage
       WHERE missing_since IS NULL AND last_updated_at >= ? AND last_updated_at < ?
       GROUP BY project_key`
    )
    .all(fromIso, toIso) as Array<{ project_key: string; tokens: number }>;

  // Codex: window by event_at (per-event), join to session for project_key.
  const codex = db
    .prepare(
      `SELECT s.project_key AS project_key,
              COALESCE(SUM(e.input_tokens + e.output_tokens), 0) AS tokens
       FROM codex_token_usage_event e
       JOIN codex_session_token_usage s ON s.session_id = e.session_id
       WHERE s.missing_since IS NULL AND e.event_at >= ? AND e.event_at < ?
       GROUP BY s.project_key`
    )
    .all(fromIso, toIso) as Array<{ project_key: string; tokens: number }>;

  const tokens = mergeTokens(claude, codex);

  const repos = (
    db.prepare("SELECT path_canonical FROM repos").all() as Array<{ path_canonical: string }>
  ).map((r) => r.path_canonical);

  const churnRows = db
    .prepare(
      `SELECT project_key,
              COALESCE(SUM(added), 0) AS added,
              COALESCE(SUM(deleted), 0) AS deleted,
              COALESCE(SUM(commits), 0) AS commits
       FROM git_line_churn
       WHERE day >= ? AND day <= ?
       GROUP BY project_key`
    )
    .all(fromDay, toDay) as Array<{ project_key: string } & RepoChurn>;
  const churn = new Map<string, RepoChurn>();
  for (const r of churnRows) {
    churn.set(r.project_key, { added: r.added, deleted: r.deleted, commits: r.commits });
  }

  // A repo counts as "scanned" once the churn collector has stored a successful sha.
  const scannedRepos = new Set(
    (
      db
        .prepare(
          "SELECT repo_path FROM git_line_churn_state WHERE last_synced_sha IS NOT NULL"
        )
        .all() as Array<{ repo_path: string }>
    ).map((r) => r.repo_path)
  );

  return projectOutputAnalysis({ tokens, repos, churn, scannedRepos });
}
