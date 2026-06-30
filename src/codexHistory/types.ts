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
