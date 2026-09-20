/**
 * kimi token 索引的共享契约。
 *
 * 结构对齐 `src/claudeTokenUsage/types.ts` —— 规则版本住在这里,写入侧
 * (`refresh.ts`)与读取侧(`queries.ts`)都从这里拿,避免两边各存一份而悄悄漂移。
 */

/**
 * 解析规则的版本。改动 `parse.ts` 的口径、或改动写进 `kimi_agent_token_usage`
 * 的任何派生字段(项目身份、标题、模型)时 +1。
 *
 * 版本不符时 `refreshKimiTokenUsage` 会把那一轮强制当全量跑 —— 逐行的跳过判据
 * 只比文件 mtime 与大小,不重刷的话代码改了库里还是旧值。
 *
 * 2:kimi 无目录会话的项目键从 `kimi:<sessionId>` 改成固定的 `kimi:unknown`、
 *   路径改成空串。见 docs/adr/0001-kimi-unknown-project-identity.md。
 */
export const KIMI_TOKEN_USAGE_RULE_VERSION = 2;

/** `kimi_token_usage_state` 的一行(V55 建的,主键恒为 1)。 */
export type KimiTokenUsageStateRow = {
  id: number;
  rule_version: number;
  last_rebuilt_at: string | null;
  last_error: string | null;
  /** 以下计数单位全部是 **agent 文件**,不是 session。 */
  source_agent_count: number;
  indexed_agent_count: number;
  token_known_agent_count: number;
  token_unknown_agent_count: number;
  error_agent_count: number;
  skipped_unchanged_count: number;
  duration_ms: number | null;
  updated_at: string;
};

/** 与 `ClaudeTokenUsageStatus` / `CodexTokenUsageStatus` 同形。 */
export type KimiTokenUsageStatus = {
  state: KimiTokenUsageStateRow | null;
  fresh: boolean;
  staleReasons: string[];
};
