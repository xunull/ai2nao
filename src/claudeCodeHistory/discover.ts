import { readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Dirent } from "node:fs";
import { decodeClaudeProjectDirName } from "./decodeProjectSlug.js";

/** Session transcript files only; excludes `*.jsonl.wakatime` and non-`.jsonl`. */
export function isSessionJsonlName(name: string): boolean {
  if (!name.endsWith(".jsonl")) return false;
  if (name.endsWith(".jsonl.wakatime")) return false;
  return true;
}

export function assertPathInsideRoot(root: string, candidate: string): string {
  const base = resolve(root);
  const target = resolve(candidate);
  if (target === base) return target;
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (!target.startsWith(prefix)) {
    throw new Error(`path escapes projects root: ${target}`);
  }
  return target;
}

export type ClaudeProjectSessionFile = {
  filePath: string;
  mtimeMs: number;
  size: number;
};

export type ClaudeProjectRow = {
  id: string;
  path: string;
  sessionCount: number;
  /** Absolute path when {@link decodeClaudeProjectDirName} fully matches this machine */
  decodedWorkspacePath: string | null;
  /** True when decoding stopped early (path moved/removed, or ambiguous on disk) */
  slugDecodeIncomplete: boolean;
  /**
   * Current on-disk session files (path + mtime + size), already stat'd while
   * counting sessions. Callers that sort by recency consume these without extra IO.
   */
  sessionFiles: ClaudeProjectSessionFile[];
};

/**
 * Discovery sort order. `"alpha"` (default) is the stable dir-name order that
 * workDashboard / sessionMemory rely on for `projects.slice(0, limit)`. Recency
 * ordering needs the token DB, so it stays in the endpoint layer, not here.
 */
export type ListProjectsSort = "alpha";

export type ClaudeSessionFileRow = {
  id: string;
  filePath: string;
  mtimeMs: number;
  size: number;
};

export async function listProjects(
  root: string,
  opts?: { sort?: ListProjectsSort }
): Promise<ClaudeProjectRow[]> {
  const base = resolve(root);
  let entries: Dirent[];
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`cannot read Claude projects directory (${base}): ${msg}`);
  }

  const rows: ClaudeProjectRow[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".")) continue;
    const path = join(base, ent.name);
    const jsonls = await listSessionJsonlFiles(path);
    const decoded = decodeClaudeProjectDirName(ent.name);
    rows.push({
      id: ent.name,
      path,
      sessionCount: jsonls.length,
      decodedWorkspacePath: decoded.incomplete ? null : decoded.path,
      slugDecodeIncomplete: decoded.incomplete,
      sessionFiles: jsonls.map((f) => ({
        filePath: f.filePath,
        mtimeMs: f.mtimeMs,
        size: f.size,
      })),
    });
  }
  // Default "alpha": stable dir-name order. Existing consumers (workDashboard,
  // sessionMemory) take projects.slice(0, limit) and depend on this determinism.
  // Recency sorting needs the token DB and lives in the endpoint layer.
  const sort: ListProjectsSort = opts?.sort ?? "alpha";
  if (sort === "alpha") {
    rows.sort((a, b) => a.id.localeCompare(b.id));
  }
  return rows;
}

export async function listSessionJsonlFiles(projectDir: string): Promise<ClaudeSessionFileRow[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(projectDir, { withFileTypes: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`cannot read project directory (${projectDir}): ${msg}`);
  }

  const rows: ClaudeSessionFileRow[] = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!isSessionJsonlName(ent.name)) continue;
    const stem = ent.name.replace(/\.jsonl$/i, "");
    const filePath = join(projectDir, ent.name);
    const st = await stat(filePath);
    rows.push({
      id: stem,
      filePath,
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows;
}
