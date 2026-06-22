/**
 * Pure "when was this project last active" reducer for the project list sort.
 *
 * Data flow:
 *
 *   discover.listProjects ──> sessionFiles[] (current disk mtime + size)
 *   claudeTokenUsage table ──> ProjectSessionTime per file_path (parsed last_updated_at,
 *                              plus the file_mtime_ms / file_size_bytes captured at sync)
 *                       │
 *                       ▼
 *            computeProjectLastActive(sessionFiles, byPath)
 *                       │
 *                       ▼
 *            lastActiveAt (ISO string) | null   ──> endpoint sorts projects DESC
 *
 * Per-session rule (keyed on SIZE, which subsumes mtime drift):
 *
 *   no DB row                         -> current disk mtime  (cold/unsynced; corrected next sync)
 *   DB row & size matches disk        -> DB last_updated_at   (clean OR pure mtime drift -> content unchanged)
 *   DB row & size differs from disk   -> current disk mtime   (content appended since sync -> new activity)
 *
 * Keying on file_size_bytes (the same disambiguator refresh.ts:220 uses) is what
 * distinguishes "mtime got bumped by iCloud/copy but content is unchanged" (trust DB)
 * from "new messages were appended" (use current mtime). It also sidesteps the
 * float-vs-truncated-int trap entirely: disk mtime is a float, the DB stores
 * Math.trunc(mtime), so a raw `===` on mtime would never match — but we never gate
 * the decision on mtime, so that trap cannot silently degrade this into a pure-mtime sort.
 *
 * The project's lastActiveAt is the max over its sessions; a project with no session
 * files yields null (sinks to the bottom of the list).
 */
import type { ClaudeProjectSessionFile } from "./discover.js";

/** A token-usage row's timing facts, looked up by absolute file_path. */
export type ProjectSessionTime = {
  lastUpdatedAt: string;
  fileMtimeMs: number;
  fileSizeBytes: number;
};

export function computeProjectLastActive(
  sessionFiles: ClaudeProjectSessionFile[],
  byPath: Map<string, ProjectSessionTime>
): string | null {
  let maxMs = -Infinity;
  let maxIso: string | null = null;

  for (const f of sessionFiles) {
    const row = byPath.get(f.filePath);
    let candidateIso: string;
    if (row && f.size === row.fileSizeBytes) {
      // size unchanged -> content unchanged -> the parsed DB time is authoritative,
      // immune to mtime drift.
      candidateIso = row.lastUpdatedAt;
    } else {
      // no row, or size changed (new content) -> current mtime is the best signal.
      candidateIso = new Date(f.mtimeMs).toISOString();
    }

    const ms = Date.parse(candidateIso);
    if (Number.isNaN(ms)) continue;
    if (ms > maxMs) {
      maxMs = ms;
      maxIso = candidateIso;
    }
  }

  return maxIso;
}
