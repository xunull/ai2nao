import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  resolveKimiCliRoot,
  resolveKimiDesktopRoot,
  sandboxDefaultWorkDir,
} from "./paths.js";
import type { KimiSessionMeta, KimiWireFile } from "./types.js";

/**
 * 标题生成用的一次性会话。桌面沙箱里实测有 12 个,与真会话 1:1 并存,
 * 内容是「给这段对话起个标题」这类内部调用 —— 不是用户的对话,必须滤掉。
 * (桌面版那份 transcripts 天然不含它们,wire.jsonl 含,所以改读 wire 之后要自己滤。)
 */
const TITLE_SESSION_PREFIX = "ctitle-";

type Root = { path: string; kind: "cli" | "desktop" };

/** 列目录,不存在或没权限时当空 —— 没装 kimi 的机器不该因此报错。 */
function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * 扫两个根下所有 agent 的 wire.jsonl。
 *
 *   <root>/<wd_*>/<session_* | conv-*>/agents/<main | agent-N>/wire.jsonl
 *
 * 目录列举失败**不**静默吞掉:调用方要靠 `dirListFailure` 决定这一轮不推水位
 * (列不出来的目录里的文件根本没进 files,没有 mtime 可以钳)。
 */
export function scanKimiWireFiles(opts?: {
  cliRoot?: string;
  desktopRoot?: string;
}): { files: KimiWireFile[]; dirListFailure: boolean } {
  const roots: Root[] = [
    { path: resolveKimiCliRoot(opts?.cliRoot), kind: "cli" },
    { path: resolveKimiDesktopRoot(opts?.desktopRoot), kind: "desktop" },
  ];

  const files: KimiWireFile[] = [];
  let dirListFailure = false;

  for (const root of roots) {
    let workspaces: string[];
    try {
      workspaces = readdirSync(root.path, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      // 根本不存在 = 这台机器没装这一侧,不是故障。
      try {
        statSync(root.path);
        dirListFailure = true; // 存在却列不出来 —— 权限问题,是故障
      } catch {
        /* 不存在,跳过 */
      }
      continue;
    }

    for (const ws of workspaces) {
      const wsDir = join(root.path, ws);
      for (const sessionId of safeDirs(wsDir)) {
        if (sessionId.startsWith(TITLE_SESSION_PREFIX)) continue;
        const agentsDir = join(wsDir, sessionId, "agents");
        for (const agent of safeDirs(agentsDir)) {
          const filePath = join(agentsDir, agent, "wire.jsonl");
          try {
            const st = statSync(filePath);
            if (!st.isFile()) continue;
            files.push({
              sessionId,
              agent,
              filePath,
              mtimeMs: st.mtimeMs,
              rootKind: root.kind,
            });
          } catch {
            /* 没有 wire.jsonl —— 空会话,跳过 */
          }
        }
      }
    }
  }

  return { files, dirListFailure };
}

/**
 * 读会话级元数据。CLI 与桌面沙箱都在会话目录下放 `state.json` ——
 * 所以桌面侧的项目归属也不需要去开 conversations.sqlite(实测两者逐条吻合)。
 *
 * **`state.json` 有两种格式,工作目录的字段名不同**(2026-08-20 实测 57 个会话):
 *
 *   旧格式  `workDir`,无 `version` 字段   34 个会话(CLI + 桌面)
 *   v2      `cwd`,   `version: 2`        23 个会话(仅 CLI)
 *
 * 只读 `workDir` 会让 v2 那 23 个会话的项目归属全丢 —— 按 token 加权是 54.5%,
 * 真库里 `agent_user_messages` 的 kimi 行曾有 1331/2188(61%)`project` 为 null。
 * 两个字段语义相同,取先有的那个。
 */
export function readKimiSessionMeta(wireFilePath: string): KimiSessionMeta {
  // <session>/agents/<agent>/wire.jsonl → <session>/state.json
  const sessionDir = join(wireFilePath, "..", "..", "..");
  try {
    const raw = JSON.parse(readFileSync(join(sessionDir, "state.json"), "utf-8")) as {
      workDir?: unknown;
      cwd?: unknown;
      title?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
    };
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
    return {
      workDir: str(raw.workDir) ?? str(raw.cwd),
      title: str(raw.title),
      createdAt: str(raw.createdAt),
      updatedAt: str(raw.updatedAt),
    };
  } catch {
    return { workDir: null, title: null, createdAt: null, updatedAt: null };
  }
}

/** 沙箱默认工作目录不是真项目 —— 见 paths.ts 的说明。 */
export function kimiProjectPath(meta: KimiSessionMeta): string | null {
  if (!meta.workDir) return null;
  return meta.workDir === sandboxDefaultWorkDir() ? null : meta.workDir;
}
