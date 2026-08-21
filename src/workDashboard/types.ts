import type { KimiProjectTokenUsage } from "../kimiTokenUsage/queries.js";
import type { KimiTokenUsageStatus } from "../kimiTokenUsage/types.js";
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

/**
 * `coveredSessions/totalSessions` 这个分数用什么计量。
 *
 * claude-code / codex / opencode 数的是**会话**,kimi 数的是 **agent 文件**
 * (一个会话下有 N 个 `agents/<x>/wire.jsonl`)。两者相加没有统计意义 ——
 * 3 场 claude 加 1 场含 4 个 agent 的 kimi 会得到「7/7」,那个数不表示任何东西。
 * 所以混在一起时报 `mixed`,由前端分开列,而不是给一个合计分数。
 * 与 `src/workTokensTrend/types.ts` 的 `coverageUnit` 同一口径。
 */
export type DashboardCoverageUnit = "session" | "agent" | "mixed" | null;

/**
 * 逐单位的覆盖率小计。`coverageUnit === "mixed"` 时前端据此分开列
 * (「3/3 会话 · 4/4 agent」),而不是显示一个把两种单位加起来的合计分数。
 */
export type DashboardCoverageBreakdown = {
  session?: { covered: number; total: number };
  agent?: { covered: number; total: number };
};

/**
 * 每个源的覆盖率计量单位。穷尽 Record —— 加源时必须在这里表态,
 * 不能靠默认值蒙混。
 */
export const SOURCE_COVERAGE_UNITS: Record<DashboardSource, "session" | "agent"> = {
  "claude-code": "session",
  codex: "session",
  opencode: "session",
  kimi: "agent",
};

export type DashboardTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  coverage: DashboardTokenCoverage;
  coverageUnit: DashboardCoverageUnit;
  coverageBreakdown: DashboardCoverageBreakdown;
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
  /**
   * kimi 的会话列表。与 listOpencode 一样不接参数 —— 数据已在 index.db 里,
   * 一次 JOIN 拿全,由 buildWorkDashboard 按 range 过滤。
   * 注意与下面 listKimiProjectTokenUsage 的**单位不同**:这里一行是一个会话,
   * 那里一行的计数单位是 agent 文件。
   */
  listKimi?: () => Promise<{
    sessions: DashboardCollectorSession[];
    diagnostics: DashboardDiagnostic[];
  }>;
  /** kimi 的计数单位是 **agent 文件**,不是 session —— 见 KimiProjectTokenUsage。 */
  listKimiProjectTokenUsage?: (args: {
    projectKeys: string[];
    from: Date | null;
  }) => Promise<Map<string, KimiProjectTokenUsage>>;
  getCodexTokenUsageStatus?: () => Promise<CodexTokenUsageStatus>;
  getKimiTokenUsageStatus?: () => Promise<KimiTokenUsageStatus>;
  getClaudeTokenUsageStatus?: () => Promise<ClaudeTokenUsageStatus>;
  getOpencodeTokenUsageStatus?: () => Promise<OpencodeTokenUsageStatus>;
  listWorkProjectDurationUsage?: (args: {
    projectKeys: string[];
    from: Date | null;
    sources: DashboardSource[];
  }) => Promise<Map<string, WorkProjectDurationUsage>>;
};
