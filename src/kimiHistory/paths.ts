import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandUserPath } from "../path/expandUserPath.js";

/** 覆盖用环境变量(测试与隔离开发靠它,生产不设)。 */
export const KIMI_CLI_ROOT_ENV = "AI2NAO_KIMI_CLI_ROOT";
export const KIMI_DESKTOP_ROOT_ENV = "AI2NAO_KIMI_DESKTOP_ROOT";

/**
 * kimi 的对话在这台机器上分两处,**时间上不重叠**(2026-07-29 是切换日):
 *
 *   cli      ~/.kimi-code/sessions/<wd_*>/<session_*>/agents/<main|agent-N>/wire.jsonl
 *   desktop  <App Support>/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/
 *              sessions/<wd_*>/<conv-*>/agents/<main|agent-N>/wire.jsonl
 *
 * 桌面版内部嵌着一份 kimi-code 沙箱,**格式与 CLI 完全相同** —— 所以两个根共用
 * 同一个解析器。桌面版另有一份 transcripts(整理过的 {role, content} 形态),但实测
 * 更少(43/114 对 30/43,conv 覆盖 12 ⊇ 11),故不读它,也就不必碰 conversations.sqlite。
 */
export function defaultKimiCliRoot(): string {
  return join(homedir(), ".kimi-code", "sessions");
}

export function defaultKimiDesktopRoot(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "kimi-desktop",
    "daimon-share",
    "daimon",
    "runtime",
    "kimi-code",
    "home",
    "sessions"
  );
}

function resolveRoot(env: string, fallback: () => string, raw?: string): string {
  const q = raw?.trim();
  if (q) return resolve(expandUserPath(q));
  const e = process.env[env]?.trim();
  if (e) return resolve(expandUserPath(e));
  return resolve(fallback());
}

export function resolveKimiCliRoot(raw?: string): string {
  return resolveRoot(KIMI_CLI_ROOT_ENV, defaultKimiCliRoot, raw);
}

export function resolveKimiDesktopRoot(raw?: string): string {
  return resolveRoot(KIMI_DESKTOP_ROOT_ENV, defaultKimiDesktopRoot, raw);
}

/**
 * 桌面版沙箱的默认工作目录。归到这里的会话不是「某个项目里的对话」,而是随口提问
 * (实测 12 个会话里 8 个是它)。直接拿它当 project 会在界面上凭空多出一个叫
 * workspace 的假项目,所以映射成 null —— 与 claude 的孤儿会话同待遇。
 */
export function sandboxDefaultWorkDir(): string {
  return join(homedir(), "Documents", "kimi", "workspace");
}
