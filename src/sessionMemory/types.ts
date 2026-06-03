import type Database from "better-sqlite3";
import type { AiEvidenceToolResult } from "../llmTools/evidence.js";

export const SESSION_MEMORY_SOURCES = [
  "ai-chat",
  "codex",
  "claude-code",
  "cursor",
  "cherry-studio",
] as const;

export type SessionMemorySource = (typeof SESSION_MEMORY_SOURCES)[number];

export type SessionMemorySearchInput = {
  query: string;
  reason?: string;
  count?: number;
  sources?: SessionMemorySource[];
};

export type NormalizedSessionMemoryRequest = {
  query: string;
  queryLower: string;
  reason?: string;
  count: number;
  sources: SessionMemorySource[];
  tokens: string[];
};

export type SessionMemoryLimits = {
  aiChatSessions: number;
  codexSessions: number;
  codexFallbackFiles: number;
  claudeProjects: number;
  claudeSessionsPerProject: number;
  cursorResults: number;
  cherryStudioResults: number;
  snippetChars: number;
};

export type SessionMemoryHit = {
  source: SessionMemorySource;
  sessionId: string;
  title: string;
  snippet: string;
  score: number;
  workspacePath?: string;
  role?: string;
  updatedAt?: string;
};

export type SessionMemorySourceSearch = (
  request: NormalizedSessionMemoryRequest,
  limits: SessionMemoryLimits
) => Promise<SessionMemoryHit[]>;

export type SessionMemoryService = {
  search(
    input: SessionMemorySearchInput,
    opts?: { signal?: AbortSignal }
  ): Promise<AiEvidenceToolResult>;
};

export type SessionMemoryServiceDeps = {
  db?: Database.Database;
  sources?: Partial<Record<SessionMemorySource, SessionMemorySourceSearch>>;
  now?: () => Date;
};
