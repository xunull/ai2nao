import { existsSync, statSync } from "node:fs";
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
 * 取 DB 主文件与其 `-wal` 旁文件里较新的一份 mtime(都不存在时返回 0)。
 *
 * 刻意不看 `-shm`:它是 WAL 的共享内存索引,任何「只读」连接(包括 ai2nao
 * 自己用 `readonly:true` 打开 DB)在 open 时就会触碰它的 mtime。若拿它判新,
 * 被读过一次的冻结库会永远显得是活的 —— 我们一读旧库就把旧库判成最新,选择
 * 永久卡死。`-wal` 只有真正写入 / checkpoint 时才更新,只读连接不碰,才是可靠
 * 的写入信号。
 */
function dbFreshnessMs(dbPath: string): number {
  let newest = 0;
  for (const p of [dbPath, `${dbPath}-wal`]) {
    try {
      newest = Math.max(newest, statSync(p).mtimeMs);
    } catch {
      // 文件不存在 —— 忽略
    }
  }
  return newest;
}

/**
 * Locate Codex's thread-list SQLite DB.
 *
 * Codex keeps flip-flopping which copy it actively writes:
 *  - 2026-06-18 it relocated its SQLite DBs INTO `~/.codex/sqlite/`, leaving the
 *    old top-level `~/.codex/state_5.sqlite` behind as a stale frozen snapshot.
 *  - By 2026-06-19 it moved BACK to the top level, freezing the `sqlite/` copy
 *    instead. (Confirmed 2026-06-30: sqlite/ stuck at 06-19 with 131 threads,
 *    top-level live at 167 threads — ~10 days of sessions silently missing.)
 *
 * Either location can be the stale one, so we cannot blindly prefer a fixed
 * path. When BOTH exist, pick whichever is freshest by mtime (counting the
 * `-wal` sidecar, since a live write usually lands there before the main file
 * mtime updates). Reading the stale copy freezes `last_updated_at` in the past,
 * so recent sessions vanish from the history list and recent token usage gets
 * bucketed on an old date. (sessions/ itself never moved — rollout_path in both
 * DBs still points at `~/.codex/sessions/...`.)
 */
export function codexStateDbPath(codexRoot: string): string {
  const relocated = join(codexRoot, "sqlite", "state_5.sqlite");
  const legacy = join(codexRoot, "state_5.sqlite");
  const hasRelocated = existsSync(relocated);
  const hasLegacy = existsSync(legacy);

  if (hasRelocated && hasLegacy) {
    return dbFreshnessMs(relocated) >= dbFreshnessMs(legacy) ? relocated : legacy;
  }
  if (hasRelocated) return relocated;
  return legacy;
}
