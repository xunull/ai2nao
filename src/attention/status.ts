import type Database from "better-sqlite3";
import { detectAttentionRuntime, knowledgeCPath } from "./paths.js";
import { probeSource } from "./read.js";

export const ATTENTION_TASK_KEY = "attention.sync";

/**
 * How long after the last successful run the source counts as stale.
 *
 * Judged from `scheduled_task_runs`, never from the task's `enabled` flag:
 * every scheduler task in this project registers disabled, so `enabled = 0`
 * says nothing about health. What actually bites is a source that *used to*
 * work and quietly stopped — `git_commits` sat 22 days behind while
 * `/commit-bridge` cheerfully rendered "0 commits".
 */
export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

export type AttentionStatusKind =
  | "ok"
  | "unsupported_runtime"
  | "not_authorized"
  | "source_unavailable"
  | "never_run"
  | "stale";

export type AttentionStatus = {
  status: AttentionStatusKind;
  /** One sentence the UI can show as-is. */
  message: string;
  /** What the user should do next, when there is something to do. */
  action?: string;
  sourcePath: string;
  runtime: ReturnType<typeof detectAttentionRuntime>;
  /** The app macOS would check for the Full Disk Access grant. */
  responsibleApp?: string;
  lastSuccessAt: string | null;
  lastRunAt: string | null;
  spanCount: number;
  coverageFromMs: number | null;
  coverageToMs: number | null;
};

/**
 * Escape hatch for development.
 *
 * The feature is packaged-app only (Full Disk Access is granted per executable
 * identity, and a `node` binary holding it would hand every node script on the
 * machine full-disk read). But `tsx watch src/cli.ts serve` is how the UI gets
 * built, and without this the page would show `unsupported_runtime` forever
 * while you are trying to lay it out. Same shape as AI2NAO_SHELL_NO_AUTOSTART.
 */
const RUNTIME_OVERRIDE_ENV = "AI2NAO_ATTENTION_ALLOW_ANY_RUNTIME";

export function getAttentionStatus(
  db: Database.Database,
  opts: { sourcePath?: string; now?: number } = {}
): AttentionStatus {
  const sourcePath = opts.sourcePath ?? knowledgeCPath();
  const now = opts.now ?? Date.now();
  const runtime = detectAttentionRuntime();
  const runs = readRuns(db);
  const spans = readSpanStats(db);

  const base = {
    sourcePath,
    runtime,
    lastSuccessAt: runs.lastSuccessAt,
    lastRunAt: runs.lastRunAt,
    spanCount: spans.count,
    coverageFromMs: spans.fromMs,
    coverageToMs: spans.toMs,
  };

  const allowAnyRuntime = process.env[RUNTIME_OVERRIDE_ENV] === "1";
  if (runtime !== "packaged-app" && !allowAnyRuntime) {
    return {
      ...base,
      status: "unsupported_runtime",
      message:
        "注意力层只在打包的 ai2nao.app 里启用。完全磁盘访问是按可执行文件授权的，给通用 node 授权等于让机器上每个 node 脚本都能读全盘。",
      action: "用 make app 打包后运行，把完全磁盘访问授给 ai2nao.app。",
    };
  }

  const probe = probeSource(sourcePath);
  if (probe.status === "not_authorized") {
    return {
      ...base,
      status: "not_authorized",
      message: "knowledgeC 存在但一个字节都读不到 —— 这是完全磁盘访问被拒的样子。",
      action:
        // 在壳里跑时，那个设置面板可以由壳直接打开 —— 网页跳不了
        // x-apple.systempreferences: 这个 scheme。不提一句的话，用户不会知道
        // 菜单里有这个入口，只能自己去系统设置里翻。
        runtime === "packaged-app"
          ? `菜单栏「服务 → 完全磁盘访问设置…」可以直接打开那个面板。把 ai2nao 加进去，然后 Cmd+Q 完全退出再打开。`
          : probe.responsibleApp
            ? `在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里授权 ${probe.responsibleApp}，然后 Cmd+Q 完全退出再打开。`
            : "在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里授权当前应用，然后完全退出再打开。",
      responsibleApp: probe.responsibleApp,
    };
  }
  if (probe.status !== "ok") {
    return {
      ...base,
      status: "source_unavailable",
      message: probe.detail ?? `数据源不可用（${probe.status}）。`,
      action:
        probe.status === "schema_mismatch"
          ? "跑 ai2nao attention probe --json 看这台机器上到底有哪些流。"
          : undefined,
    };
  }

  // Source is readable. Now: has the task ever actually run?
  if (runs.lastSuccessAt === null) {
    return {
      ...base,
      status: "never_run",
      message:
        "数据源可读，但同步任务从没成功跑过 —— 所有定时任务出生时都是关闭的。",
      action: "去 /scheduler 启用 attention.sync，或者点一次 Run now。",
    };
  }

  const ageMs = now - Date.parse(runs.lastSuccessAt);
  if (Number.isFinite(ageMs) && ageMs > STALE_AFTER_MS) {
    const days = Math.floor(ageMs / 86_400_000);
    return {
      ...base,
      status: "stale",
      message: `同步任务曾经成功过，但最后一次是 ${days} 天前 —— 页面上的数据截止到那时。`,
      action: "去 /scheduler 看这个任务是被关掉了还是一直在失败。",
    };
  }

  return {
    ...base,
    status: "ok",
    message: "数据源可读，同步正常。",
  };
}

function readRuns(db: Database.Database): {
  lastSuccessAt: string | null;
  lastRunAt: string | null;
} {
  const row = db
    .prepare(
      `SELECT MAX(CASE WHEN status = 'success' THEN finished_at END) AS ok_at,
              MAX(finished_at) AS any_at
         FROM scheduled_task_runs
        WHERE task_key = ?`
    )
    .get(ATTENTION_TASK_KEY) as { ok_at: string | null; any_at: string | null };
  return { lastSuccessAt: row?.ok_at ?? null, lastRunAt: row?.any_at ?? null };
}

function readSpanStats(db: Database.Database): {
  count: number;
  fromMs: number | null;
  toMs: number | null;
} {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n, MIN(start_ms) AS a, MAX(end_ms) AS b FROM attention_focus_spans"
    )
    .get() as { n: number; a: number | null; b: number | null };
  return { count: row.n, fromMs: row.a, toMs: row.b };
}
