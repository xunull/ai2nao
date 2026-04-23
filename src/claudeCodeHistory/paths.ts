import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandPath } from "../cursorHistory/platform.js";

export const CLAUDE_PROJECTS_ENV = "CLAUDE_CODE_PROJECTS_ROOT";

export function defaultClaudeProjectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

/**
 * Resolve the directory that contains per-project subfolders (each holding `*.jsonl`).
 * Priority: explicit `projectsRoot` → env → default `~/.claude/projects`.
 */
export function resolveClaudeProjectsRoot(projectsRoot?: string): string {
  const q = projectsRoot?.trim();
  if (q) return resolve(expandPath(q));
  const env = process.env[CLAUDE_PROJECTS_ENV]?.trim();
  if (env) return resolve(expandPath(env));
  return resolve(defaultClaudeProjectsRoot());
}
