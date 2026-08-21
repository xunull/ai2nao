import type { KimiProjectTokenUsage } from "../kimiTokenUsage/queries.js";
import type { Diagnostic } from "../util/diagnostics.js";
import type { ChatSession, ChatSessionSummary } from "../cursorHistory/types.js";
import type { ClaudeProjectTokenUsage, ClaudeTokenUsageStatus } from "../claudeTokenUsage/types.js";
import type { CodexProjectTokenUsage, CodexTokenUsageStatus } from "../codexTokenUsage/types.js";
import type {
  OpencodeProjectTokenUsage,
  OpencodeTokenUsageStatus,
} from "../opencodeTokenUsage/types.js";
import type { WorkProjectDurationUsage } from "../workDuration/types.js";

export const DASHBOARD_SOURCES = ["claude-code", "codex", "opencode", "kimi"] as const;

export type DashboardSource = (typeof DASHBOARD_SOURCES)[number];

export function isDashboardSource(value: unknown): value is DashboardSource {
  return (DASHBOARD_SOURCES as readonly string[]).includes(value as string);
}

export type DashboardTokenCoverage = "full" | "partial" | "unknown";

export type DashboardTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  coverage: DashboardTokenCoverage;
  coveredSessions: number;
  totalSessions: number;
  scannedSessions: number;
  scanLimit: number;
  truncated: boolean;
};

export type DashboardDiagnostic = Diagnostic & {
  source: DashboardSource;
  path?: string;
  count?: number;
};

export type DashboardSession = {
  id: string;
  source: DashboardSource;
  projectKey: string;
  projectPath: string;
  identityConfidence: "high" | "low";
  title: string;
  preview: string;
  createdAt: Date;
  lastUpdatedAt: Date;
  messageCount: number;
  tokenUsage?: DashboardTokenUsage;
  model?: string;
  gitBranch?: string;
  detailHref: string;
  raw: ChatSessionSummary;
};

export type DashboardProject = {
  key: string;
  label: string;
  path: string;
  identityConfidence: "high" | "low";
  lastUpdatedAt: Date;
  sessionCount: number;
  sourceCounts: Record<DashboardSource, number>;
  tokenUsage: DashboardTokenUsage;
  recentSessions: DashboardSession[];
};

export type DashboardRange = {
  from: Date | null;
  to: Date;
  days: number | "all";
};

export type WorkDashboardOptions = {
  rangeDays: number | "all";
  sources: DashboardSource[];
  limitProjects: number;
  sessionsPerProject: number;
  tokenSessionsPerProject: number;
  claudeProjectLimit: number;
  claudeSessionsPerProject: number;
  codexSessionLimit: number;
  codexFallbackFiles: number;
};

export type WorkDashboardResponse = {
  ok: true;
  generatedAt: Date;
  range: DashboardRange;
  /** 本次请求实际用的源 —— 前端下拉的选中态读这个,而不是自己记一份。 */
  sources: DashboardSource[];
  /**
   * 后端代码支持的全部源。前端据此渲染下拉选项:`web/` 与 `src/` 是两个
   * tsconfig,编译期共享不到 `DASHBOARD_SOURCES`,所以走运行时下发。
   */
  availableSources: DashboardSource[];
  diagnostics: DashboardDiagnostic[];
  totals: {
    projectCount: number;
    sessionCount: number;
    tokenUsage: DashboardTokenUsage;
    sourceCounts: Record<DashboardSource, number>;
  };
  projects: DashboardProject[];
};

export type WorkTokenRankingRange = {
  from: Date | null;
  to: Date;
  months: 1 | 3 | 6 | 12 | "all";
};

export type WorkTokenRankingOptions = {
  rangeMonths: 1 | 3 | 6 | 12 | "all";
  sources: DashboardSource[];
  limit: number;
  claudeProjectLimit: number;
  claudeSessionsPerProject: number;
  codexSessionLimit: number;
  codexFallbackFiles: number;
};

export type WorkTokenRankingProject = {
  key: string;
  label: string;
  path: string;
  totalTokens: number;
  activeMs: number;
};

export type WorkTokenRankingResponse = {
  ok: true;
  generatedAt: Date;
  range: WorkTokenRankingRange;
  sources: DashboardSource[];
  /** 见 WorkDashboardResponse.availableSources。 */
  availableSources: DashboardSource[];
  diagnostics: DashboardDiagnostic[];
  projects: WorkTokenRankingProject[];
};

export type DashboardCollectorSession = {
  source: DashboardSource;
  summary: ChatSessionSummary;
  decodedWorkspacePath?: string | null;
};

export type DashboardCollectors = {
  listClaude: (limits: {
    projectLimit: number;
    sessionsPerProject: number;
  }) => Promise<{
    sessions: DashboardCollectorSession[];
    diagnostics: DashboardDiagnostic[];
  }>;
  listCodex: (limits: {
    sessionLimit: number;
    fallbackFiles: number;
  }) => Promise<{
    sessions: DashboardCollectorSession[];
    diagnostics: DashboardDiagnostic[];
  }>;
  loadClaudeDetail: (
    projectId: string,
    sessionId: string
  ) => Promise<ChatSession | null>;
  loadCodexDetail: (sessionId: string) => Promise<ChatSession | null>;
  listCodexProjectTokenUsage?: (args: {
    projectKeys: string[];
    from: Date | null;
  }) => Promise<Map<string, CodexProjectTokenUsage>>;
  listClaudeProjectTokenUsage?: (args: {
    projectKeys: string[];
    from: Date | null;
  }) => Promise<Map<string, ClaudeProjectTokenUsage>>;
  // opencode: token comes straight from the opencode.db `session` columns, so it
  // is always "indexed" (never file-scanned). No loadOpencodeDetail — session
  // detail is a separate round.
  listOpencode?: () => Promise<{
    sessions: DashboardCollectorSession[];
    diagnostics: DashboardDiagnostic[];
  }>;
  listOpencodeProjectTokenUsage?: (args: {
    projectKeys: string[];
    from: Date | null;
  }) => Promise<Map<string, OpencodeProjectTokenUsage>>;
  /** kimi 的计数单位是 **agent 文件**,不是 session —— 见 KimiProjectTokenUsage。 */
  listKimiProjectTokenUsage?: (args: {
    projectKeys: string[];
    from: Date | null;
  }) => Promise<Map<string, KimiProjectTokenUsage>>;
  getCodexTokenUsageStatus?: () => Promise<CodexTokenUsageStatus>;
  getClaudeTokenUsageStatus?: () => Promise<ClaudeTokenUsageStatus>;
  getOpencodeTokenUsageStatus?: () => Promise<OpencodeTokenUsageStatus>;
  listWorkProjectDurationUsage?: (args: {
    projectKeys: string[];
    from: Date | null;
    sources: DashboardSource[];
  }) => Promise<Map<string, WorkProjectDurationUsage>>;
};
