import { isAbsolute } from "node:path";
import { canonicalizePath } from "../path/canonical.js";

export type WorkProjectSource = "claude-code" | "codex" | "opencode" | "kimi";

export type WorkProjectIdentityInput = {
  source: WorkProjectSource;
  fallbackId: string;
  decodedWorkspacePath?: string | null;
  cwd?: string | null;
  workspacePath?: string | null;
  workspaceId?: string | null;
};

export type WorkProjectIdentity = {
  key: string;
  path: string;
  confidence: "high" | "low";
};

/**
 * 「确定不属于任何工作目录」的会话的展示名。判据是 `path === ""` ——
 * 空串表示确定没有目录,不是「还没查出来」(后者是索引缺陷,要报诊断)。
 *
 * 出现在三处:工作看板的项目卡片、Kimi 列表左栏、codex 列表左栏。第三次出现才抽出来。
 */
export const UNKNOWN_PROJECT_LABEL = "(未知项目)";

/** kimi 无目录会话共用的项目键。见 docs/adr/0001-kimi-unknown-project-identity.md。 */
export const KIMI_UNKNOWN_PROJECT_KEY = "kimi:unknown";

export function normalizeWorkProjectIdentity(
  input: WorkProjectIdentityInput
): WorkProjectIdentity {
  const candidates = [
    input.decodedWorkspacePath,
    input.cwd,
    input.workspacePath,
    input.workspaceId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed || !isAbsolute(trimmed)) continue;
    const canonical = canonicalizePath(trimmed, { bestEffort: true });
    if (canonical) return { key: canonical, path: canonical, confidence: "high" };
  }

  // kimi 的无目录会话(桌面沙箱里用默认工作目录开的随手提问)走到这里时一个候选都没有。
  // 通用兜底会给**每一场**造一个 `kimi:<sessionId>` 的独立键,而这个键正是工作看板的
  // 成组依据 —— 真库里 8 场随手提问因此变成了看板上 8 行项目。归到一个固定键上,
  // 路径留空表示「确定不属于任何目录」。见 docs/adr/0001-kimi-unknown-project-identity.md。
  //
  // 判据用「一个候选都没有」而不是 source === 'kimi':workDir 万一是个相对路径,
  // 它过不了 isAbsolute 但仍然是有用的信息,不该被抹成未知。
  const hasCandidate = candidates.some((c) => typeof c === "string" && c.trim() !== "");
  if (input.source === "kimi" && !hasCandidate) {
    return { key: KIMI_UNKNOWN_PROJECT_KEY, path: "", confidence: "low" };
  }

  const fallback = `${input.source}:${input.workspaceId || input.fallbackId}`;
  return {
    key: fallback,
    path: input.workspacePath || input.cwd || fallback,
    confidence: "low",
  };
}
