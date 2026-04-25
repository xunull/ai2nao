import { basename, dirname } from "node:path";
import type Database from "better-sqlite3";
import type { ListQueryOptions } from "../serve/listQuery.js";
import { getVscodeStatus as getSourceStatus, parseVscodeAppId } from "./paths.js";
import type {
  VscodeAppId,
  VscodeRecentProject,
  VscodeRecentRow,
  VscodeRepoSummary,
  VscodeWarning,
} from "./types.js";

export type VscodeEntryFilters = ListQueryOptions & {
  app?: string;
  profile?: string;
  kind?: string;
  scope?: "all" | "local" | "remote";
};

export function getVscodeMirrorStatus(
  db: Database.Database,
  opts: { app?: string; profile?: string } = {}
) {
  const app = requireApp(opts.app);
  const profile = cleanProfile(opts.profile);
  const source = getSourceStatus(app);
  const counts = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN missing_since IS NULL THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN missing_since IS NOT NULL THEN 1 ELSE 0 END) AS missing,
        SUM(CASE WHEN remote_type IS NOT NULL AND missing_since IS NULL THEN 1 ELSE 0 END) AS remote
       FROM vscode_recent_entries
       WHERE app = ? AND profile = ?`
    )
    .get(app, profile) as {
      total: number;
      active: number | null;
      missing: number | null;
      remote: number | null;
    };
  const lastSeen = db
    .prepare(
      `SELECT MAX(last_seen_at) AS lastSeenAt
       FROM vscode_recent_entries
       WHERE app = ? AND profile = ?`
    )
    .get(app, profile) as { lastSeenAt: string | null };
  return {
    ...source,
    profile,
    counts: {
      total: counts.total,
      active: counts.active ?? 0,
      missing: counts.missing ?? 0,
      remote: counts.remote ?? 0,
    },
    lastSeenAt: lastSeen.lastSeenAt,
  };
}

export function listVscodeRecentEntries(db: Database.Database, opts: VscodeEntryFilters) {
  const app = requireApp(opts.app);
  const profile = cleanProfile(opts.profile);
  const where: string[] = ["app = ?", "profile = ?"];
  const params: unknown[] = [app, profile];
  if (!opts.includeMissing) where.push("missing_since IS NULL");
  if (opts.kind) {
    if (!["folder", "file", "workspace"].includes(opts.kind)) throw new Error("invalid kind");
    where.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts.scope === "local") where.push("remote_type IS NULL");
  if (opts.scope === "remote") where.push("remote_type IS NOT NULL");
  if (opts.q) {
    where.push("(COALESCE(label, '') LIKE ? OR COALESCE(path, '') LIKE ? OR uri_redacted LIKE ? OR COALESCE(remote_type, '') LIKE ?)");
    const q = `%${opts.q}%`;
    params.push(q, q, q, q);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM vscode_recent_entries ${clause}`).get(...params) as {
      n: number;
    }
  ).n;
  const rows = db
    .prepare(
      `SELECT id, app, profile, kind, recent_index, uri_redacted, path, label,
              remote_type, remote_authority_hash, remote_path_hash, exists_on_disk,
              first_seen_at, last_seen_at, missing_since, updated_at
       FROM vscode_recent_entries
       ${clause}
       ORDER BY missing_since IS NOT NULL, recent_index ASC, updated_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, opts.limit, opts.offset) as VscodeRecentRow[];
  return { rows, total, limit: opts.limit, offset: opts.offset };
}

export function listVscodeRecentProjects(db: Database.Database, opts: VscodeEntryFilters) {
  const app = requireApp(opts.app);
  const profile = cleanProfile(opts.profile);
  const warnings: VscodeWarning[] = [];
  let repos: VscodeRepoSummary[] = [];
  try {
    repos = db
      .prepare(
        `SELECT id, path_canonical, origin_url
         FROM repos
         ORDER BY LENGTH(path_canonical) DESC, path_canonical ASC`
      )
      .all() as VscodeRepoSummary[];
  } catch (e) {
    warnings.push({
      code: "repo_association_failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
  const rows = listVscodeRecentEntries(db, {
    ...opts,
    app,
    profile,
    q: undefined,
    limit: 10_000,
    offset: 0,
  }).rows;
  const groups = new Map<string, VscodeRecentProject>();
  for (const row of rows) {
    const repo = row.path ? matchRepo(row.path, repos) : null;
    const key = repo
      ? `repo:${repo.id}`
      : row.remote_type
        ? `remote:${row.remote_type}:${row.remote_authority_hash ?? ""}:${row.remote_path_hash ?? ""}`
        : `path:${projectPath(row) ?? row.uri_redacted}`;
    const path = repo?.path_canonical ?? projectPath(row);
    const label = repo
      ? basename(repo.path_canonical)
      : row.label ?? (path ? basename(path) : row.remote_type ?? row.kind);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        label,
        path,
        repo,
        entryCount: 1,
        latestRecentIndex: row.recent_index,
        kind: row.kind,
        remoteType: row.remote_type,
        remoteAuthorityHash: row.remote_authority_hash,
        missing: row.missing_since != null || row.exists_on_disk === 0,
        app,
        profile,
      });
    } else {
      existing.entryCount += 1;
      existing.latestRecentIndex = Math.min(existing.latestRecentIndex, row.recent_index);
      existing.missing = existing.missing && (row.missing_since != null || row.exists_on_disk === 0);
    }
  }
  const filtered = [...groups.values()]
    .filter((project) => {
      if (!opts.q) return true;
      const q = opts.q.toLowerCase();
      return [project.label, project.path, project.repo?.origin_url, project.remoteType]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    })
    .sort((a, b) => a.latestRecentIndex - b.latestRecentIndex || a.label.localeCompare(b.label));
  return {
    rows: filtered.slice(opts.offset, opts.offset + opts.limit),
    total: filtered.length,
    limit: opts.limit,
    offset: opts.offset,
    warnings,
  };
}

function matchRepo(path: string, repos: VscodeRepoSummary[]): VscodeRepoSummary | null {
  for (const repo of repos) {
    if (path === repo.path_canonical || path.startsWith(`${repo.path_canonical}/`)) return repo;
  }
  return null;
}

function projectPath(row: VscodeRecentRow): string | null {
  if (!row.path) return null;
  return row.kind === "file" ? dirname(row.path) : row.path;
}

function requireApp(raw: string | undefined): VscodeAppId {
  const app = parseVscodeAppId(raw ?? "code");
  if (!app) throw new Error("invalid app");
  return app;
}

function cleanProfile(raw: string | undefined): string {
  const t = (raw ?? "default").trim();
  return t || "default";
}
