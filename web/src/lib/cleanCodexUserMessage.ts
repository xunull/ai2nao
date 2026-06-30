/**
 * 把 codex transcript 里 `role:"user"` 的正文清洗成「真人手打」。
 *
 * 抽屉先按 `metadata.codexSource === "event_msg"` 过滤(已排除 AGENTS.md 注入 +
 * codex 把每条 user 记两遍的双份),user 消息基本就是真人输入。唯一残留是
 * `codex exec` / 外部声音运行注入的**样板 prompt** —— 它也走 `event_msg/user_message`,
 * 但不是人交互打的。整条丢弃,纯 exec 会话因此显示空态(准确)。
 *
 * best-effort:exec 样板靠固定前缀识别(是 gstack 自己注入的串,稳定但非数据真相);
 * 长期应换成 rollout 的结构化 originator 信号(见设计文档 §7 TODO)。
 */

/**
 * gstack 外部声音 / codex exec 注入的文件系统边界样板 prompt 的开头
 * （见 /plan-eng-review、/office-hours 等 skill 的 codex exec 调用)。
 */
const CODEX_EXEC_BOILERPLATE_PREFIX =
  "IMPORTANT: Do NOT read or execute any files under ~/.claude/";

export function cleanCodexUserMessage(raw: string): string {
  if (!raw) return "";
  // 命中 exec 样板 → 整条丢弃(不是剥前缀,否则后面残余会被当手打内容)。
  // 仅 startsWith:正文中段偶然含 "IMPORTANT" 的普通消息不受影响。
  if (raw.trimStart().startsWith(CODEX_EXEC_BOILERPLATE_PREFIX)) return "";
  return raw.trim();
}
