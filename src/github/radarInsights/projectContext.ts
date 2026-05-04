import type Database from "better-sqlite3";
import { DEFAULT_PROJECT_CONTEXT } from "../../config.js";
import { sha1, source, type CurrentWorkSource } from "./currentWork.js";
import type { RadarInsightWarning } from "./types.js";

type ProjectContextRow = {
  repo_id: number;
  repo_path: string;
  rel_path: string;
  size_bytes: number | null;
  sha256_hex: string | null;
  body: string;
};

export type ProjectContextResult = {
  sources: CurrentWorkSource[];
  warnings: RadarInsightWarning[];
  docs_scanned: number;
  docs_skipped: number;
  project_context_hash: string | null;
};

export function listIndexedProjectSources(db: Database.Database): ProjectContextResult {
  const repoCount = (db.prepare("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c;
  if (repoCount === 0) {
    return emptyResult({
      code: "no_indexed_projects",
      message: "No indexed local projects are available. Run ai2nao scan --root <workspace>.",
    });
  }

  const totalContextRows = countProjectContextRows(db);
  const rows = db
    .prepare(
      `SELECT r.id AS repo_id, r.path_canonical AS repo_path,
              m.rel_path, m.size_bytes, m.sha256_hex, m.body
       FROM manifest_files m
       JOIN repos r ON r.id = m.repo_id
       WHERE m.rel_path IN (${fixedRelPlaceholders()})
          OR m.rel_path LIKE 'docs/%.md'
       ORDER BY
         CASE
           WHEN m.rel_path = 'TODOS.md' THEN 0
           WHEN m.rel_path LIKE 'docs/%.md' THEN 1
           WHEN m.rel_path IN ('README.md', 'README', 'readme.md') THEN 2
           ELSE 3
         END ASC,
         COALESCE(r.last_scanned_at, r.first_seen_at) DESC,
         r.path_canonical ASC,
         m.rel_path ASC
       LIMIT ?`
    )
    .all(...DEFAULT_PROJECT_CONTEXT.fixedManifestRels, DEFAULT_PROJECT_CONTEXT.maxRadarSources * 2) as ProjectContextRow[];

  if (rows.length === 0) {
    return emptyResult({
      code: "project_context_empty",
      message: "Indexed local projects have no README, TODOS, manifests, or docs context yet.",
    });
  }

  const warnings: RadarInsightWarning[] = [];
  const sources: CurrentWorkSource[] = [];
  const hashes: string[] = [];
  const projects = new Set<number>();
  let skipped = 0;
  const skippedByQueryLimit = Math.max(0, totalContextRows - rows.length);

  for (const row of rows) {
    if (projects.size >= DEFAULT_PROJECT_CONTEXT.maxRadarProjects && !projects.has(row.repo_id)) {
      skipped++;
      continue;
    }
    if ((row.size_bytes ?? row.body.length) > DEFAULT_PROJECT_CONTEXT.maxRadarSourceBytes) {
      skipped++;
      continue;
    }
    if (sources.length >= DEFAULT_PROJECT_CONTEXT.maxRadarSources) {
      skipped++;
      continue;
    }
    projects.add(row.repo_id);
    const label = `${repoLabel(row.repo_path)}/${row.rel_path}`;
    const kind = row.rel_path === "TODOS.md" ? "todo" : "doc";
    sources.push(source(kind, label, label, row.body));
    hashes.push(sha1(`${row.repo_id}\n${row.rel_path}\n${row.sha256_hex ?? sha1(row.body)}`));
  }

  if (skipped > 0 || skippedByQueryLimit > 0) {
    const totalSkipped = skipped + skippedByQueryLimit;
    warnings.push({
      code: "project_context_skipped",
      message: `${totalSkipped} indexed project context files were skipped by radar limits.`,
    });
  }

  return {
    sources,
    warnings,
    docs_scanned: sources.length,
    docs_skipped: skipped + skippedByQueryLimit,
    project_context_hash: hashes.length > 0 ? sha1(hashes.sort().join("\n")) : null,
  };
}

function countProjectContextRows(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM manifest_files
       WHERE rel_path IN (${fixedRelPlaceholders()})
          OR rel_path LIKE 'docs/%.md'`
    )
    .get(...DEFAULT_PROJECT_CONTEXT.fixedManifestRels) as { c: number };
  return row.c;
}

function emptyResult(warning: RadarInsightWarning): ProjectContextResult {
  return {
    sources: [],
    warnings: [warning],
    docs_scanned: 0,
    docs_skipped: 0,
    project_context_hash: null,
  };
}

function fixedRelPlaceholders(): string {
  return DEFAULT_PROJECT_CONTEXT.fixedManifestRels.map(() => "?").join(", ");
}

function repoLabel(root: string): string {
  return root.split("/").filter(Boolean).pop() ?? root;
}
