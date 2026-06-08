import { basename, dirname } from "node:path";
import {
  listProjects,
  listSessionSummaries as listClaudeSessionSummaries,
  loadSessionDetail as loadClaudeSessionDetail,
  resolveClaudeProjectsRoot,
} from "../claudeCodeHistory/index.js";
import {
  listCodexSessionSummaries,
  loadCodexSessionDetail,
} from "../codexHistory/index.js";
import type Database from "better-sqlite3";
import {
  getClaudeTokenUsageStatus,
  listClaudeProjectTokenUsage,
} from "../claudeTokenUsage/queries.js";
import {
  getCodexTokenUsageStatus,
  listCodexProjectTokenUsage,
} from "../codexTokenUsage/queries.js";
import type { ChatSession, ChatSessionSummary } from "../cursorHistory/types.js";
import {
  normalizeWorkProjectIdentity,
} from "../workProjects/identity.js";
import type {
  DashboardCollectorSession,
  DashboardCollectors,
  DashboardDiagnostic,
  DashboardProject,
  DashboardSession,
  DashboardSource,
  DashboardTokenUsage,
  WorkTokenRankingOptions,
  WorkTokenRankingProject,
  WorkTokenRankingResponse,
  WorkDashboardOptions,
  WorkDashboardResponse,
} from "./types.js";
import type { CodexProjectTokenUsage } from "../codexTokenUsage/types.js";

export const DEFAULT_WORK_DASHBOARD_OPTIONS: WorkDashboardOptions = {
  rangeDays: 30,
  sources: ["claude-code", "codex"],
  limitProjects: 80,
  sessionsPerProject: 5,
  tokenSessionsPerProject: 5,
  claudeProjectLimit: 80,
  claudeSessionsPerProject: 30,
  codexSessionLimit: 300,
  codexFallbackFiles: 1000,
};

const MAX_LIMITS = {
  limitProjects: 300,
  tokenRankingLimit: 500,
  sessionsPerProject: 20,
  tokenSessionsPerProject: 20,
  claudeProjectLimit: 300,
  claudeSessionsPerProject: 100,
  codexSessionLimit: 1000,
  codexFallbackFiles: 5000,
};

export const DEFAULT_WORK_TOKEN_RANKING_OPTIONS: WorkTokenRankingOptions = {
  rangeMonths: 6,
  sources: ["claude-code", "codex"],
  limit: 100,
  claudeProjectLimit: 300,
  claudeSessionsPerProject: 100,
  codexSessionLimit: 1000,
  codexFallbackFiles: 5000,
};

function clampPositiveInt(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.trunc(value), max);
}

export function normalizeDashboardOptions(
  partial: Partial<WorkDashboardOptions> = {}
): WorkDashboardOptions {
  const defaults = DEFAULT_WORK_DASHBOARD_OPTIONS;
  const sources = (partial.sources ?? defaults.sources).filter(
    (source): source is DashboardSource =>
      source === "claude-code" || source === "codex"
  );
  return {
    rangeDays: partial.rangeDays ?? defaults.rangeDays,
    sources: sources.length > 0 ? [...new Set(sources)] : defaults.sources,
    limitProjects: clampPositiveInt(
      partial.limitProjects ?? defaults.limitProjects,
      defaults.limitProjects,
      MAX_LIMITS.limitProjects
    ),
    sessionsPerProject: clampPositiveInt(
      partial.sessionsPerProject ?? defaults.sessionsPerProject,
      defaults.sessionsPerProject,
      MAX_LIMITS.sessionsPerProject
    ),
    tokenSessionsPerProject: clampPositiveInt(
      partial.tokenSessionsPerProject ?? defaults.tokenSessionsPerProject,
      defaults.tokenSessionsPerProject,
      MAX_LIMITS.tokenSessionsPerProject
    ),
    claudeProjectLimit: clampPositiveInt(
      partial.claudeProjectLimit ?? defaults.claudeProjectLimit,
      defaults.claudeProjectLimit,
      MAX_LIMITS.claudeProjectLimit
    ),
    claudeSessionsPerProject: clampPositiveInt(
      partial.claudeSessionsPerProject ?? defaults.claudeSessionsPerProject,
      defaults.claudeSessionsPerProject,
      MAX_LIMITS.claudeSessionsPerProject
    ),
    codexSessionLimit: clampPositiveInt(
      partial.codexSessionLimit ?? defaults.codexSessionLimit,
      defaults.codexSessionLimit,
      MAX_LIMITS.codexSessionLimit
    ),
    codexFallbackFiles: clampPositiveInt(
      partial.codexFallbackFiles ?? defaults.codexFallbackFiles,
      defaults.codexFallbackFiles,
      MAX_LIMITS.codexFallbackFiles
    ),
  };
}

export function dashboardRange(rangeDays: number | "all", now = new Date()) {
  if (rangeDays === "all") return { from: null, to: now, days: "all" as const };
  const days = Math.max(1, Math.trunc(rangeDays));
  return {
    from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
    to: now,
    days,
  };
}

export function normalizeTokenRankingOptions(
  partial: Partial<WorkTokenRankingOptions> = {}
): WorkTokenRankingOptions {
  const defaults = DEFAULT_WORK_TOKEN_RANKING_OPTIONS;
  const sources = (partial.sources ?? defaults.sources).filter(
    (source): source is DashboardSource =>
      source === "claude-code" || source === "codex"
  );
  const rangeMonths = partial.rangeMonths ?? defaults.rangeMonths;
  return {
    rangeMonths: [1, 3, 6, 12, "all"].includes(rangeMonths)
      ? rangeMonths
      : defaults.rangeMonths,
    sources: sources.length > 0 ? [...new Set(sources)] : defaults.sources,
    limit: clampPositiveInt(
      partial.limit ?? defaults.limit,
      defaults.limit,
      MAX_LIMITS.tokenRankingLimit
    ),
    claudeProjectLimit: clampPositiveInt(
      partial.claudeProjectLimit ?? defaults.claudeProjectLimit,
      defaults.claudeProjectLimit,
      MAX_LIMITS.claudeProjectLimit
    ),
    claudeSessionsPerProject: clampPositiveInt(
      partial.claudeSessionsPerProject ?? defaults.claudeSessionsPerProject,
      defaults.claudeSessionsPerProject,
      MAX_LIMITS.claudeSessionsPerProject
    ),
    codexSessionLimit: clampPositiveInt(
      partial.codexSessionLimit ?? defaults.codexSessionLimit,
      defaults.codexSessionLimit,
      MAX_LIMITS.codexSessionLimit
    ),
    codexFallbackFiles: clampPositiveInt(
      partial.codexFallbackFiles ?? defaults.codexFallbackFiles,
      defaults.codexFallbackFiles,
      MAX_LIMITS.codexFallbackFiles
    ),
  };
}

export function dashboardMonthRange(
  rangeMonths: WorkTokenRankingOptions["rangeMonths"],
  now = new Date()
) {
  if (rangeMonths === "all") return { from: null, to: now, months: "all" as const };
  const from = new Date(now);
  from.setMonth(from.getMonth() - rangeMonths);
  return { from, to: now, months: rangeMonths };
}

function emptyTokenUsage(totalSessions: number, scanLimit: number): DashboardTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    coverage: "unknown",
    coveredSessions: 0,
    totalSessions,
    scannedSessions: 0,
    scanLimit,
    truncated: totalSessions > scanLimit,
  };
}

function usageFromSession(session: ChatSession | null | undefined) {
  const input = session?.usage?.totalInputTokens;
  const output = session?.usage?.totalOutputTokens;
  if (typeof input !== "number" || typeof output !== "number") return null;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { inputTokens: input, outputTokens: output };
}

function sourceCounts(): Record<DashboardSource, number> {
  return { "claude-code": 0, codex: 0 };
}

export function normalizeDashboardProjectPath(
  source: DashboardSource,
  summary: ChatSessionSummary,
  decodedWorkspacePath?: string | null
): { key: string; path: string; confidence: "high" | "low" } {
  const codex = summary.metadata?.codex as { cwd?: unknown } | undefined;
  return normalizeWorkProjectIdentity({
    source,
    fallbackId: summary.id,
    decodedWorkspacePath,
    cwd: typeof codex?.cwd === "string" ? codex.cwd : undefined,
    workspacePath: summary.workspacePath,
    workspaceId: summary.workspaceId,
  });
}

function projectLabel(path: string, used: Map<string, number>): string {
  const base = basename(path) || path;
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  if (count === 0) return base;
  const parent = basename(dirname(path));
  return parent ? `${parent}/${base}` : base;
}

function metadataString(summary: ChatSessionSummary, key: "model" | "gitBranch") {
  const codex = summary.metadata?.codex as Record<string, unknown> | undefined;
  const value = codex?.[key];
  return typeof value === "string" ? value : undefined;
}

function detailHref(source: DashboardSource, summary: ChatSessionSummary): string {
  const id = encodeURIComponent(summary.id);
  if (source === "codex") return `/codex-history/s/${id}`;
  const p = new URLSearchParams();
  p.set("projectId", summary.workspaceId);
  return `/claude-code-history/s/${id}?${p.toString()}`;
}

function dashboardSessionFromSummary(
  item: DashboardCollectorSession
): DashboardSession {
  const identity = normalizeDashboardProjectPath(
    item.source,
    item.summary,
    item.decodedWorkspacePath
  );
  return {
    id: item.summary.id,
    source: item.source,
    projectKey: identity.key,
    projectPath: identity.path,
    identityConfidence: identity.confidence,
    title: item.summary.title?.trim() || "无标题会话",
    preview: item.summary.preview,
    createdAt: item.summary.createdAt,
    lastUpdatedAt: item.summary.lastUpdatedAt,
    messageCount: item.summary.messageCount,
    model: metadataString(item.summary, "model"),
    gitBranch: metadataString(item.summary, "gitBranch"),
    detailHref: detailHref(item.source, item.summary),
    raw: item.summary,
  };
}

async function collectDefaultClaude(limits: {
  projectLimit: number;
  sessionsPerProject: number;
}): Promise<{ sessions: DashboardCollectorSession[]; diagnostics: DashboardDiagnostic[] }> {
  const diagnostics: DashboardDiagnostic[] = [];
  const sessions: DashboardCollectorSession[] = [];
  const root = resolveClaudeProjectsRoot();
  let projects;
  try {
    projects = await listProjects(root);
  } catch (e) {
    return {
      sessions,
      diagnostics: [{
        source: "claude-code",
        severity: "error",
        kind: "source-unavailable",
        message: e instanceof Error ? e.message : String(e),
        path: root,
      }],
    };
  }

  if (projects.length > limits.projectLimit) {
    diagnostics.push({
      source: "claude-code",
      severity: "warning",
      kind: "project-scan-truncated",
      message: `Claude project scan limited to ${limits.projectLimit}`,
      count: projects.length,
    });
  }

  for (const project of projects.slice(0, limits.projectLimit)) {
    try {
      const rows = await listClaudeSessionSummaries(root, project.id, {
        limit: limits.sessionsPerProject,
      });
      if (project.sessionCount > limits.sessionsPerProject) {
        diagnostics.push({
          source: "claude-code",
          severity: "warning",
          kind: "session-scan-truncated",
          message: `Claude sessions limited to ${limits.sessionsPerProject} for project`,
          path: project.decodedWorkspacePath ?? project.path,
          count: project.sessionCount,
        });
      }
      for (const summary of rows) {
        sessions.push({
          source: "claude-code",
          summary: { ...summary, source: "claude-code" },
          decodedWorkspacePath: project.decodedWorkspacePath,
        });
      }
    } catch (e) {
      diagnostics.push({
        source: "claude-code",
        severity: "warning",
        kind: "project-read-failed",
        message: e instanceof Error ? e.message : String(e),
        path: project.decodedWorkspacePath ?? project.path,
      });
    }
  }
  return { sessions, diagnostics };
}

async function collectDefaultCodex(limits: {
  sessionLimit: number;
  fallbackFiles: number;
}): Promise<{ sessions: DashboardCollectorSession[]; diagnostics: DashboardDiagnostic[] }> {
  try {
    const result = await listCodexSessionSummaries(undefined, {
      archived: false,
      limit: limits.sessionLimit,
      maxFiles: limits.fallbackFiles,
    });
    const diagnostics: DashboardDiagnostic[] = result.diagnostics.map((d) => ({
      source: "codex",
      severity: "warning",
      kind: d.kind,
      message: d.message,
      path: d.path,
      count: d.count,
    }));
    if (result.truncated || result.scannedCount >= limits.sessionLimit) {
      diagnostics.push({
        source: "codex",
        severity: "warning",
        kind: "session-scan-truncated",
        message: `Codex sessions limited to ${limits.sessionLimit}`,
        count: result.scannedCount,
      });
    }
    return {
      sessions: result.sessions.map((summary) => ({
        source: "codex",
        summary: { ...summary, source: "codex" },
      })),
      diagnostics,
    };
  } catch (e) {
    return {
      sessions: [],
      diagnostics: [{
        source: "codex",
        severity: "error",
        kind: "source-unavailable",
        message: e instanceof Error ? e.message : String(e),
      }],
    };
  }
}

export function defaultDashboardCollectors(db?: Database.Database): DashboardCollectors {
  return {
    listClaude: collectDefaultClaude,
    listCodex: collectDefaultCodex,
    loadClaudeDetail: async (projectId, sessionId) =>
      (await loadClaudeSessionDetail(resolveClaudeProjectsRoot(), projectId, sessionId))?.session ?? null,
    loadCodexDetail: async (sessionId) =>
      (await loadCodexSessionDetail(undefined, sessionId))?.session ?? null,
    listCodexProjectTokenUsage: db
      ? async ({ projectKeys, from }) => listCodexProjectTokenUsage(db, { projectKeys, from })
      : undefined,
    listClaudeProjectTokenUsage: db
      ? async ({ projectKeys, from }) => listClaudeProjectTokenUsage(db, { projectKeys, from })
      : undefined,
    getCodexTokenUsageStatus: db
      ? async () => getCodexTokenUsageStatus(db)
      : undefined,
    getClaudeTokenUsageStatus: db
      ? async () => getClaudeTokenUsageStatus(db)
      : undefined,
  };
}

async function applyTokenUsage(
  project: DashboardProject,
  collectors: DashboardCollectors,
  diagnostics: DashboardDiagnostic[],
  scanLimit: number,
  indexedCodexUsage?: CodexProjectTokenUsage
): Promise<void> {
  const hasIndexedCodex = Boolean(indexedCodexUsage);
  const toScan = project.recentSessions
    .filter((session) => !hasIndexedCodex || session.source !== "codex")
    .slice(0, scanLimit);
  let inputTokens = 0;
  let outputTokens = 0;
  let coveredSessions = 0;
  let totalSessions = hasIndexedCodex
    ? indexedCodexUsage?.totalSessions ?? 0
    : 0;
  let scannedSessions = 0;

  for (const session of toScan) {
    let detail: ChatSession | null = null;
    try {
      detail = session.source === "claude-code"
        ? await collectors.loadClaudeDetail(session.raw.workspaceId, session.id)
        : await collectors.loadCodexDetail(session.id);
    } catch (e) {
      diagnostics.push({
        source: session.source,
        severity: "warning",
        kind: "detail-read-failed",
        message: e instanceof Error ? e.message : String(e),
        path: session.projectPath,
      });
    }
    const usage = usageFromSession(detail);
    if (!usage) continue;
    coveredSessions++;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    totalSessions++;
    scannedSessions++;
  }

  if (indexedCodexUsage) {
    inputTokens += indexedCodexUsage.inputTokens;
    outputTokens += indexedCodexUsage.outputTokens;
    coveredSessions += indexedCodexUsage.coveredSessions;
  }

  if (!hasIndexedCodex) {
    totalSessions = project.sessionCount;
    scannedSessions = toScan.length;
  }
  const truncated = !hasIndexedCodex && project.sessionCount > scanLimit;
  project.tokenUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    coverage:
      coveredSessions === 0
        ? "unknown"
        : indexedCodexUsage?.coverage === "partial"
          ? "partial"
          : coveredSessions === totalSessions && !truncated
          ? "full"
          : "partial",
    coveredSessions,
    totalSessions,
    scannedSessions: hasIndexedCodex ? totalSessions : scannedSessions,
    scanLimit,
    truncated,
  };
  if (truncated) {
    diagnostics.push({
      source: project.sourceCounts["claude-code"] > 0 ? "claude-code" : "codex",
      severity: "warning",
      kind: "token-scan-truncated",
      message: `Token detail scan limited to ${scanLimit} sessions for project ${project.label}`,
      path: project.path,
      count: project.sessionCount,
    });
  }
}

function totalTokenUsage(projects: DashboardProject[], scanLimit: number) {
  const out = emptyTokenUsage(0, scanLimit);
  out.coverage = "full";
  for (const project of projects) {
    out.inputTokens += project.tokenUsage.inputTokens;
    out.outputTokens += project.tokenUsage.outputTokens;
    out.totalTokens += project.tokenUsage.totalTokens;
    out.coveredSessions += project.tokenUsage.coveredSessions;
    out.totalSessions += project.tokenUsage.totalSessions;
    out.scannedSessions += project.tokenUsage.scannedSessions;
    out.truncated = out.truncated || project.tokenUsage.truncated;
    if (project.tokenUsage.coverage === "unknown" && out.coverage === "full") {
      out.coverage = "partial";
    }
    if (project.tokenUsage.coverage === "partial") out.coverage = "partial";
  }
  if (out.coveredSessions === 0) out.coverage = "unknown";
  return out;
}

type IndexedCodexUsage = Awaited<ReturnType<NonNullable<DashboardCollectors["listCodexProjectTokenUsage"]>>>;

export async function buildWorkDashboard(
  partialOptions: Partial<WorkDashboardOptions> = {},
  deps: DashboardCollectors = defaultDashboardCollectors(),
  now = new Date()
): Promise<WorkDashboardResponse> {
  const options = normalizeDashboardOptions(partialOptions);
  const range = dashboardRange(options.rangeDays, now);
  const diagnostics: DashboardDiagnostic[] = [];
  const collected: DashboardCollectorSession[] = [];

  if (options.sources.includes("claude-code")) {
    const res = await deps.listClaude({
      projectLimit: options.claudeProjectLimit,
      sessionsPerProject: options.claudeSessionsPerProject,
    });
    collected.push(...res.sessions);
    diagnostics.push(...res.diagnostics);
  }
  if (options.sources.includes("codex")) {
    const res = await deps.listCodex({
      sessionLimit: options.codexSessionLimit,
      fallbackFiles: options.codexFallbackFiles,
    });
    collected.push(...res.sessions);
    diagnostics.push(...res.diagnostics);
  }

  const sessions = collected
    .map(dashboardSessionFromSummary)
    .filter((session) =>
      range.from ? session.lastUpdatedAt.getTime() >= range.from.getTime() : true
    )
    .sort((a, b) => b.lastUpdatedAt.getTime() - a.lastUpdatedAt.getTime());

  const projectsByKey = new Map<string, DashboardProject>();
  for (const session of sessions) {
    let project = projectsByKey.get(session.projectKey);
    if (!project) {
      project = {
        key: session.projectKey,
        label: session.projectPath,
        path: session.projectPath,
        identityConfidence: session.identityConfidence,
        lastUpdatedAt: session.lastUpdatedAt,
        sessionCount: 0,
        sourceCounts: sourceCounts(),
        tokenUsage: emptyTokenUsage(0, options.tokenSessionsPerProject),
        recentSessions: [],
      };
      projectsByKey.set(session.projectKey, project);
    }
    project.sessionCount++;
    project.sourceCounts[session.source]++;
    if (session.identityConfidence === "high") project.identityConfidence = "high";
    if (session.lastUpdatedAt > project.lastUpdatedAt) {
      project.lastUpdatedAt = session.lastUpdatedAt;
    }
    project.recentSessions.push(session);
  }

  const labelCounts = new Map<string, number>();
  const projects = [...projectsByKey.values()]
    .sort((a, b) => b.lastUpdatedAt.getTime() - a.lastUpdatedAt.getTime())
    .slice(0, options.limitProjects);
  let indexedCodexByProject: IndexedCodexUsage | undefined;
  if (options.sources.includes("codex") && deps.listCodexProjectTokenUsage) {
    try {
      const status = deps.getCodexTokenUsageStatus
        ? await deps.getCodexTokenUsageStatus()
        : null;
      if (status && !status.fresh) {
        diagnostics.push({
          source: "codex",
          severity: "warning",
          kind: "codex-token-index-stale",
          message: `Codex token index is stale: ${status.staleReasons.join(", ")}`,
          count: status.state?.indexed_session_count,
        });
      }
      indexedCodexByProject = await deps.listCodexProjectTokenUsage({
        projectKeys: projects.map((project) => project.key),
        from: range.from,
      });
    } catch (e) {
      diagnostics.push({
        source: "codex",
        severity: "warning",
        kind: "codex-token-index-unavailable",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  for (const project of projects) {
    project.recentSessions = project.recentSessions
      .sort((a, b) => b.lastUpdatedAt.getTime() - a.lastUpdatedAt.getTime())
      .slice(0, Math.max(options.sessionsPerProject, options.tokenSessionsPerProject));
    project.label = projectLabel(project.path, labelCounts);
    await applyTokenUsage(
      project,
      deps,
      diagnostics,
      options.tokenSessionsPerProject,
      indexedCodexByProject?.get(project.key)
    );
    project.recentSessions = project.recentSessions.slice(0, options.sessionsPerProject);
  }

  const totalsSourceCounts = sourceCounts();
  for (const project of projects) {
    totalsSourceCounts["claude-code"] += project.sourceCounts["claude-code"];
    totalsSourceCounts.codex += project.sourceCounts.codex;
  }

  return {
    ok: true,
    generatedAt: now,
    range,
    diagnostics,
    totals: {
      projectCount: projects.length,
      sessionCount: projects.reduce((sum, p) => sum + p.sessionCount, 0),
      tokenUsage: totalTokenUsage(projects, options.tokenSessionsPerProject),
      sourceCounts: totalsSourceCounts,
    },
    projects,
  };
}

type RankingAccumulator = {
  key: string;
  path: string;
  totalTokens: number;
  lastUpdatedAt: Date;
};

function addRankingTokens(
  projects: Map<string, RankingAccumulator>,
  key: string,
  path: string,
  totalTokens: number,
  lastUpdatedAt: Date
) {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return;
  const existing = projects.get(key);
  if (!existing) {
    projects.set(key, { key, path, totalTokens, lastUpdatedAt });
    return;
  }
  existing.totalTokens += totalTokens;
  if (lastUpdatedAt > existing.lastUpdatedAt) existing.lastUpdatedAt = lastUpdatedAt;
}

export async function buildWorkTokenRanking(
  partialOptions: Partial<WorkTokenRankingOptions> = {},
  deps: DashboardCollectors = defaultDashboardCollectors(),
  now = new Date()
): Promise<WorkTokenRankingResponse> {
  const options = normalizeTokenRankingOptions(partialOptions);
  const range = dashboardMonthRange(options.rangeMonths, now);
  const diagnostics: DashboardDiagnostic[] = [];
  const projectsByKey = new Map<string, RankingAccumulator>();

  if (options.sources.includes("codex") && deps.listCodexProjectTokenUsage) {
    try {
      const status = deps.getCodexTokenUsageStatus
        ? await deps.getCodexTokenUsageStatus()
        : null;
      if (status && !status.fresh) {
        diagnostics.push({
          source: "codex",
          severity: "warning",
          kind: "codex-token-index-stale",
          message: `Codex token index is stale: ${status.staleReasons.join(", ")}`,
          count: status.state?.indexed_session_count,
        });
      }
      const codexUsage = await deps.listCodexProjectTokenUsage({
        projectKeys: [],
        from: range.from,
      });
      for (const usage of codexUsage.values()) {
        addRankingTokens(
          projectsByKey,
          usage.projectKey,
          usage.projectPath,
          usage.totalTokens,
          range.to
        );
      }
    } catch (e) {
      diagnostics.push({
        source: "codex",
        severity: "warning",
        kind: "codex-token-index-unavailable",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  } else if (options.sources.includes("codex")) {
    diagnostics.push({
      source: "codex",
      severity: "warning",
      kind: "codex-token-index-unavailable",
      message: "Codex token index is not configured",
    });
  }

  if (options.sources.includes("claude-code") && deps.listClaudeProjectTokenUsage) {
    try {
      const status = deps.getClaudeTokenUsageStatus
        ? await deps.getClaudeTokenUsageStatus()
        : null;
      if (status && !status.fresh) {
        diagnostics.push({
          source: "claude-code",
          severity: "warning",
          kind: "claude-token-index-stale",
          message: `Claude token index is stale: ${status.staleReasons.join(", ")}`,
          count: status.state?.indexed_session_count,
        });
      }
      const claudeUsage = await deps.listClaudeProjectTokenUsage({
        projectKeys: [],
        from: range.from,
      });
      for (const usage of claudeUsage.values()) {
        addRankingTokens(
          projectsByKey,
          usage.projectKey,
          usage.projectPath,
          usage.totalTokens,
          range.to
        );
      }
    } catch (e) {
      diagnostics.push({
        source: "claude-code",
        severity: "warning",
        kind: "claude-token-index-unavailable",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  } else if (options.sources.includes("claude-code")) {
    diagnostics.push({
      source: "claude-code",
      severity: "warning",
      kind: "claude-token-index-unavailable",
      message: "Claude token index is not configured",
    });
  }

  const labelCounts = new Map<string, number>();
  const projects: WorkTokenRankingProject[] = [...projectsByKey.values()]
    .sort((a, b) =>
      b.totalTokens - a.totalTokens ||
      b.lastUpdatedAt.getTime() - a.lastUpdatedAt.getTime()
    )
    .slice(0, options.limit)
    .map((project) => ({
      key: project.key,
      label: projectLabel(project.path, labelCounts),
      path: project.path,
      totalTokens: project.totalTokens,
    }));

  return {
    ok: true,
    generatedAt: now,
    range,
    sources: options.sources,
    diagnostics,
    projects,
  };
}
