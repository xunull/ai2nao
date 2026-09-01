import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandUserPath } from "../path/expandUserPath.js";

export const HERMES_HOME_ENV = "HERMES_HOME";

/**
 * 定位 hermes 的数据目录。Hermes Agent(NousResearch)把所有状态放在 `~/.hermes`，
 * 会话与消息在其中的 `state.db`(SQLite + FTS5)。
 * 源码里对该目录的描述见 hermes 自己的 `--help`:"default (~/.hermes)"。
 */
export function defaultHermesHome(): string {
  return join(homedir(), ".hermes");
}

export function resolveHermesHome(raw?: string): string {
  const q = raw?.trim();
  if (q) return resolve(expandUserPath(q));
  const env = process.env[HERMES_HOME_ENV]?.trim();
  if (env) return resolve(expandUserPath(env));
  return resolve(defaultHermesHome());
}

export function hermesDbPath(home: string): string {
  return join(home, "state.db");
}
