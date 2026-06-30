import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandUserPath } from "../path/expandUserPath.js";

export const OPENCODE_DATA_ENV = "OPENCODE_DATA_DIR";

/**
 * 定位 opencode 的数据目录。opencode(SST,与 oh-my-opencode 共用)默认放在
 * `$XDG_DATA_HOME/opencode`，未设 XDG 时回落 `~/.local/share/opencode`。
 */
export function defaultOpencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return join(resolve(expandUserPath(xdg)), "opencode");
  return join(homedir(), ".local", "share", "opencode");
}

export function resolveOpencodeDataDir(raw?: string): string {
  const q = raw?.trim();
  if (q) return resolve(expandUserPath(q));
  const env = process.env[OPENCODE_DATA_ENV]?.trim();
  if (env) return resolve(expandUserPath(env));
  return resolve(defaultOpencodeDataDir());
}

export function opencodeDbPath(dataDir: string): string {
  return join(dataDir, "opencode.db");
}
