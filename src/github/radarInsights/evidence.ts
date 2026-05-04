import type Database from "better-sqlite3";
import { parseTopicsSafe } from "../queries.js";
import type { CurrentWorkSource } from "./currentWork.js";
import { extractTerms } from "./currentWork.js";
import type { RadarInsightEvidence } from "./types.js";

export type RadarCandidateRepo = {
  repo_id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  language: string | null;
  topics: string[];
  tags: string[];
  stargazers_count: number;
  starred_at: string;
  archived: boolean;
  pushed_at: string | null;
  repo_terms: string[];
};

type CandidateRow = {
  repo_id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  language: string | null;
  topics_json: string;
  stargazers_count: number;
  starred_at: string;
  archived: number;
  pushed_at: string | null;
  tags_csv: string | null;
};

export function listRadarCandidates(
  db: Database.Database,
  limit = 200
): RadarCandidateRepo[] {
  const rows = db
    .prepare(
      `SELECT
         s.repo_id, s.owner, s.name, s.full_name, s.description, s.html_url,
         s.language, s.topics_json, s.stargazers_count, s.starred_at,
         s.archived, s.pushed_at,
         GROUP_CONCAT(t.tag, ',') AS tags_csv
       FROM gh_star s
       LEFT JOIN gh_repo_tag t ON t.repo_id = s.repo_id
       GROUP BY s.repo_id
       ORDER BY
         CASE WHEN s.archived = 0 THEN 0 ELSE 1 END ASC,
         COALESCE(s.pushed_at, '') DESC,
         s.starred_at DESC,
         s.stargazers_count DESC
       LIMIT ?`
    )
    .all(limit) as CandidateRow[];
  return rows.map((r) => {
    const topics = parseTopicsSafe(r.topics_json, `gh_star.repo_id=${r.repo_id}`);
    const tags = (r.tags_csv ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const repoTerms = [
      ...topics,
      ...tags,
      ...(r.language ? [r.language] : []),
      ...extractTerms(`${r.full_name} ${r.description ?? ""}`, 24),
    ].map((t) => t.toLowerCase());
    return {
      repo_id: r.repo_id,
      owner: r.owner,
      name: r.name,
      full_name: r.full_name,
      description: r.description,
      html_url: r.html_url,
      language: r.language,
      topics,
      tags,
      stargazers_count: r.stargazers_count,
      starred_at: r.starred_at,
      archived: r.archived !== 0,
      pushed_at: r.pushed_at,
      repo_terms: [...new Set(repoTerms)],
    };
  });
}

export function buildEvidenceForRepo(
  repo: RadarCandidateRepo,
  sources: CurrentWorkSource[]
): RadarInsightEvidence[] {
  const evidence: RadarInsightEvidence[] = [];
  const topicTerms = [...new Set([...repo.topics, ...repo.tags])].slice(0, 6);
  if (topicTerms.length > 0) {
    evidence.push({
      source_kind: "topic",
      label: "GitHub topics",
      source_path: null,
      matched_terms: topicTerms,
      weight: 2,
    });
  }
  if (repo.description || repo.language) {
    evidence.push({
      source_kind: "repo_fact",
      label: repo.language ? `language: ${repo.language}` : "repo description",
      source_path: null,
      matched_terms: extractTerms(`${repo.description ?? ""} ${repo.language ?? ""}`, 8),
      weight: 1,
    });
  }

  const repoTermSet = new Set(repo.repo_terms);
  for (const s of sources) {
    const matched = s.terms.filter((t) => repoTermSet.has(t)).slice(0, 6);
    if (matched.length === 0) continue;
    evidence.push({
      source_kind: s.source_kind,
      label: s.label,
      source_path: s.source_path,
      matched_terms: matched,
      weight: s.source_kind === "todo" ? 4 : s.source_kind === "doc" ? 3 : 2,
    });
  }

  return evidence;
}

export function evidenceTerms(evidence: RadarInsightEvidence[]): string[] {
  const terms = new Set<string>();
  for (const e of evidence) {
    for (const t of e.matched_terms) terms.add(t);
  }
  return [...terms].slice(0, 16);
}

export function hasCurrentWorkEvidence(evidence: RadarInsightEvidence[]): boolean {
  return evidence.some((e) =>
    e.source_kind === "todo" ||
    e.source_kind === "doc" ||
    e.source_kind === "git_commit" ||
    e.source_kind === "branch"
  );
}
