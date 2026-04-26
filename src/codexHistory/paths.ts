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

export function codexStateDbPath(codexRoot: string): string {
  return join(codexRoot, "state_5.sqlite");
}
