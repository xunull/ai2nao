import type { ChatSession, ChatSessionSummary } from "../cursorHistory/types.js";
import type { CodexDiagnostic, CodexErrorKind } from "./errors.js";

export type CodexSessionMetrics = {
  toolCallCount: number;
  commandCount: number;
  failedCommandCount: number;
  fileCount: number;
};

export type CodexSessionMetadata = {
  cwd: string;
  gitBranch?: string;
  model?: string;
  archived: boolean;
  rolloutPath?: string;
  degraded?: boolean;
  degradationReason?: CodexErrorKind;
  metrics: CodexSessionMetrics;
  /**
   * 程序化会话(codex exec / 审批 / 插件):user_message 全是机器注入,非真人输入。
   * 保留为 `sessionKind !== "normal"` 的别名 —— 旧调用方不改一行仍然正确。
   */
  programmatic?: boolean;
  /**
   * 会话性质三态(2026-08-18)。原来只有 programmatic 一个布尔值,把三种性质完全不同的
   * 会话压成了一类,结果是「整场跳过」误杀了大量真人内容。全量实测 349 个会话:
   *
   *   normal    126 会话  AI 正文 13.24 MB  user 清洗后非空 5933/5933  ← 主体
   *   subagent  137 会话  AI 正文  2.57 MB  user 清洗后非空 1087/1884
   *   exec       86 会话  AI 正文  0.37 MB  user 清洗后非空   12/83
   *
   * 三者的处理各不相同(见 extractCodexMessages):normal 两侧全收;subagent 只收
   * assistant(它的 user 侧是派给 codex 的审查 prompt,而 assistant 侧是 codex 写的
   * 审查意见,有价值);exec 两侧都跳(实测 user 侧那 12 条也是机器 prompt 残留)。
   */
  sessionKind?: "normal" | "subagent" | "exec";
};

export type CodexThreadRow = {
  id: string;
  rolloutPath: string;
  createdAt: Date;
  lastUpdatedAt: Date;
  title: string;
  cwd: string;
  archived: boolean;
  gitBranch?: string;
  model?: string;
  firstUserMessage?: string;
};

export type CodexListFilters = {
  cwd?: string;
  gitBranch?: string;
  model?: string;
  archived?: boolean;
  limit?: number;
  maxFiles?: number;
};

export type CodexProjectSummary = {
  /** 归一化项目 key(= cwd 去尾斜杠);空 = 未知项目。前端用它作 ?cwd= 选中值。 */
  id: string;
  /** 项目绝对路径(未知项目为 "")。 */
  path: string;
  /** 展示名:basename;未知项目为「(未知项目)」。 */
  name: string;
  sessionCount: number;
  /** 该项目下 session 的最近活跃时间(ISO)。 */
  lastActiveAt: string;
};

export type CodexProjectsResult = {
  ok: true;
  source: "sqlite" | "fallback";
  codexRoot: string;
  stateDbPath: string;
  diagnostics: CodexDiagnostic[];
  projects: CodexProjectSummary[];
};

export type CodexListResult = {
  ok: true;
  source: "sqlite" | "fallback";
  codexRoot: string;
  sessionsRoot: string;
  stateDbPath: string;
  diagnostics: CodexDiagnostic[];
  scannedCount: number;
  truncated: boolean;
  sessions: ChatSessionSummary[];
};

export type BuiltCodexSession = {
  session: ChatSession;
  summary: ChatSessionSummary;
  warnings: string[];
  metrics: CodexSessionMetrics;
};
