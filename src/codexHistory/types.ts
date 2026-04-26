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
