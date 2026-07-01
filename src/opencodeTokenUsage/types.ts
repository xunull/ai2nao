/**
 * opencode 的 token 用量：直接来自 opencode.db 的 `session` 列（tokens_input/output/…），
 * 无 refresh、无单独索引表。形状对齐 CodexProjectTokenUsage，供工作看板按 project 合并。
 */
export type OpencodeProjectTokenUsage = {
  /** canonicalizePath(session.directory) —— 与 claude/codex 的 project_key 同口径，才能跨源合并。 */
  projectKey: string;
  projectPath: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  coveredSessions: number;
  totalSessions: number;
  errorSessions: number;
  /** token 列缺失(旧 schema) → "unknown"(不假装 full);否则 "full"。 */
  coverage: "full" | "partial" | "unknown";
};

export type OpencodeTokenUsageStatus = {
  /** opencode 无 refresh，token 直接在列里 → 恒 fresh。 */
  fresh: boolean;
  staleReasons: string[];
};
