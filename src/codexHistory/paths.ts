import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandUserPath } from "../path/expandUserPath.js";
import { CODEX_ROOT_ENV } from "./constants.js";

export function defaultCodexRoot(): string {
  return join(homedir(), ".codex");
}

export function resolveCodexRoot(raw?: string): string {
  const q = raw?.trim();
  if (q) return resolve(expandUserPath(q));
  const env = process.env[CODEX_ROOT_ENV]?.trim();
  if (env) return resolve(expandUserPath(env));
  return resolve(defaultCodexRoot());
}

export function codexSessionsRoot(codexRoot: string): string {
  return join(codexRoot, "sessions");
}

/**
 * Locate Codex's thread-list SQLite DB.
 *
 * Newer Codex versions relocated their SQLite databases into a `sqlite/`
 * subfolder (`~/.codex/sqlite/state_5.sqlite`), leaving the old top-level
 * `~/.codex/state_5.sqlite` behind as a STALE frozen snapshot. Reading the
 * stale copy makes resumed sessions look like they stopped at their last
 * pre-relocation update — their `last_updated_at` freezes in the past, so
 * recent token usage gets bucketed on an old date and "disappears" from
 * recent-days views. Investigation 2026-06-18.
 *
 * Prefer the new path when it exists; fall back to the legacy top-level path
 * for older Codex installs (sessions/ itself did NOT move — rollout_path in
 * both DBs still points at `~/.codex/sessions/...`).
 */
export function codexStateDbPath(codexRoot: string): string {
  const relocated = join(codexRoot, "sqlite", "state_5.sqlite");
  if (existsSync(relocated)) return relocated;
  return join(codexRoot, "state_5.sqlite");
}
