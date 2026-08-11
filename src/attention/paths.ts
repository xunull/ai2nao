import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * macOS CoreDuet knowledgeC database.
 *
 * Reading this file requires **Full Disk Access** (TCC). The POSIX bits are
 * readable but `open()` is denied without the grant, and the block is at the
 * *directory* level: listing the parent returns nothing even though `stat` on a
 * full known path succeeds. That is why nothing here tries to discover sidecar
 * files (`-wal` / `-shm`) by listing — see `read.ts`.
 */
export function knowledgeCPath(): string {
  return join(
    homedir(),
    "Library/Application Support/Knowledge/knowledgeC.db"
  );
}

/** knowledgeC only exists on macOS. */
export function isAttentionSourceSupported(): boolean {
  return process.platform === "darwin";
}

/**
 * How this process was launched, which decides whether the *feature* is enabled.
 *
 * Full Disk Access is granted per executable identity, so the three runtimes are
 * three separate grants:
 *
 *   tsx watch src/cli.ts serve  -> the terminal app holds the grant
 *   packaged .app (daemon)      -> com.xunull.ai2nao holds the grant   <- supported
 *   npm-installed CLI           -> the node binary holds the grant     <- refused
 *
 * The npm path is refused on purpose: granting FDA to a shared `node` binary
 * gives every node script on the machine full-disk read. Diagnostics (`probe`)
 * still run everywhere — they only *report* the runtime, they do not gate on it.
 */
export type AttentionRuntime = "packaged-app" | "cli" | "unknown";

export function detectAttentionRuntime(): AttentionRuntime {
  // Electron sets this even under ELECTRON_RUN_AS_NODE, which is how the
  // packaged daemon is spawned (see desktop/src/daemonProcess.ts).
  if (process.versions.electron) return "packaged-app";
  if (process.platform === "darwin") return "cli";
  return "unknown";
}

/**
 * The bundle macOS will actually check when this process touches a protected
 * file — the topmost `.app` in the process ancestry, not the `node` binary
 * running the code.
 *
 * Telling someone to "grant Full Disk Access" without naming the target is how
 * they end up granting it to the wrong app, seeing no change, and concluding
 * the feature is broken. A CLI launched from a terminal emulator is attributed
 * to that emulator, and nesting is common: zsh <- claude <- zsh <- Warp.app.
 *
 * Best-effort by design: returns null rather than throwing when `ps` is
 * unavailable or the chain holds no `.app` (a launchd-spawned daemon, say).
 */
export function responsibleAppPath(): string | null {
  if (process.platform !== "darwin") return null;
  let pid = process.pid;
  let last: string | null = null;
  // Bounded so a malformed ppid chain cannot spin.
  for (let hop = 0; hop < 12 && pid > 1; hop++) {
    const info = psInfo(pid);
    if (!info) break;
    const marker = info.comm.indexOf(".app/");
    if (marker !== -1) last = info.comm.slice(0, marker + 4);
    if (info.ppid <= 1 || info.ppid === pid) break;
    pid = info.ppid;
  }
  return last;
}

function psInfo(pid: number): { ppid: number; comm: string } | null {
  try {
    const out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    if (!out) return null;
    const m = out.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) return null;
    return { ppid: Number.parseInt(m[1]!, 10), comm: m[2]!.trim() };
  } catch {
    return null;
  }
}
