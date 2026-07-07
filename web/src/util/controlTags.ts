/**
 * Claude Code / Codex CLI 注入进 user 消息的「控制标签」名。
 *
 * 这份是**前端渲染专用副本**。唯一权威定义在仓库根
 * `src/workCosmos/summarize.ts` 的 `CONTROL_TAG_PATTERNS`(embedding 降噪用)。
 * web 是独立 TS 工程(`web/tsconfig.json` include 只含 `web/src`,无 vite alias
 * 指向仓库根 `src/`),import 不到那份 —— 故复制这 12 个名字。
 *
 * 两边靠 `test/controlTags.drift.test.ts` 守一致:改这里必同步改 summarize.ts,
 * 否则测试红。别让前后端语义静默分叉。
 */
export const CONTROL_TAG_NAMES = [
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "command-message",
  "command-name",
  "command-args",
  "command-stdout",
  "command-stderr",
  "system-reminder",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
] as const;

export type ControlTagName = (typeof CONTROL_TAG_NAMES)[number];
