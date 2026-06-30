import type { ChatSession, ChatSessionSummary } from "../cursorHistory/types.js";
import type { OpencodeDiagnostic } from "./errors.js";

export type OpencodeListFilters = {
  /** 真分组键 = project.id（不是 worktree/directory）。 */
  projectId?: string;
  agent?: string;
  model?: string;
  archived?: boolean;
  limit?: number;
};

/** opencode session 一行（已从 DB 取出，未读 message/part）。 */
export type OpencodeSessionRow = {
  id: string;
  projectId: string;
  title: string;
  directory: string;
  model?: string;
  agent?: string;
  archived: boolean;
  createdAt: Date;
  lastUpdatedAt: Date;
  tokensInput: number;
  tokensOutput: number;
  cost: number;
};

/** opencode project 聚合（左栏）。 */
export type OpencodeProjectSummary = {
  /** project.id —— 真分组键 */
  id: string;
  /** project.worktree —— repo 路径 */
  path: string;
  /** 展示名：project.name 优先，否则 basename(worktree) */
  name: string;
  sessionCount: number;
  lastActiveAt: string;
};

export type OpencodeProjectsResult = {
  ok: true;
  source: "sqlite";
  dbPath: string;
  diagnostics: OpencodeDiagnostic[];
  projects: OpencodeProjectSummary[];
};

export type OpencodeListResult = {
  ok: true;
  source: "sqlite";
  dbPath: string;
  diagnostics: OpencodeDiagnostic[];
  sessions: ChatSessionSummary[];
};

export type BuiltOpencodeSession = {
  session: ChatSession;
  warnings: string[];
};
