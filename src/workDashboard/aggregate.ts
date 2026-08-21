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
  listClaudeDashboardSessions,
  listClaudeProjectTokenUsage,
} from "../claudeTokenUsage/queries.js";
import {
  getCodexTokenUsageStatus,
  listCodexProjectTokenUsage,
} from "../codexTokenUsage/queries.js";
import { listOpencodeSessionSummaries } from "../opencodeHistory/index.js";
import {
  getOpencodeTokenUsageStatus,
  listOpencodeProjectTokenUsage,
} from "../opencodeTokenUsage/queries.js";
import {
  getKimiTokenUsageStatus,
  listKimiProjectTokenUsage,
} from "../kimiTokenUsage/queries.js";
import { listKimiDashboardSessions } from "../kimiHistory/sessions.js";
import { listWorkProjectDurationUsage } from "../workDuration/queries.js";
import type { WorkDurationSource } from "../workDuration/types.js";
import type { ChatSession, ChatSessionSummary } from "../cursorHistory/types.js";
import {
  normalizeWorkProjectIdentity,
} from "../workProjects/identity.js";
import { DASHBOARD_SOURCES, isDashboardSource, SOURCE_COVERAGE_UNITS } from "./types.js";
import type {
  DashboardCollectorSession,
  DashboardCollectors,
  DashboardCoverageBreakdown,
  DashboardCoverageUnit,
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

export const DEFAULT_WORK_DASHBOARD_OPTIONS: WorkDashboardOptions = {
  rangeDays: 30,
  sources: [...DASHBOARD_SOURCES],
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
  sources: [...DASHBOARD_SOURCES],
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
  const sources = (partial.sources ?? defaults.sources).filter(isDashboardSource);
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
  const sources = (partial.sources ?? defaults.sources).filter(isDashboardSource);
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
    coverageUnit: null,
    coverageBreakdown: {},
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
  return Object.fromEntries(
    DASHBOARD_SOURCES.map((source) => [source, 0])
  ) as Record<DashboardSource, number>;
}

export function normalizeDashboardProjectPath(
  source: DashboardSource,
  summary: ChatSessionSummary,
  decodedWorkspacePath?: string | null
): { key: string; path: string; confidence: "high" | "low" } {
  // Index-backed Claude sessions carry the identity computed at sync time —
  // reuse it verbatim so the dashboard never re-normalizes (and never drifts
  // from the project_key the token index aggregates under).
  const indexed = summary.metadata?.indexed as
    | { key: string; path: string; confidence: "high" | "low" }
    | undefined;
  if (indexed) return indexed;
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

const DETAIL_HREF_BUILDERS: Record<
  DashboardSource,
  (summary: ChatSessionSummary) => string
> = {
  "claude-code": (summary) => {
    const p = new URLSearchParams();
    p.set("projectId", summary.workspaceId);
    return `/claude-code-history/s/${encodeURIComponent(summary.id)}?${p.toString()}`;
  },
  codex: (summary) => `/codex-history/s/${encodeURIComponent(summary.id)}`,
  opencode: (summary) => `/opencode-history/s/${encodeURIComponent(summary.id)}`,
  // kimi 在看板里是**只出 token 的源**:它不往 recentSessions 里塞会话,
  // 所以这个 builder 实际不会被调到。留在这里是为了让 Record<DashboardSource, …>
  // 完整 —— 将来真做了 kimi 会话详情页,编译器会提醒这里要改。
  kimi: (summary) => `/agent-messages?source=kimi&q=${encodeURIComponent(summary.id)}`,
};

function detailHref(source: DashboardSource, summary: ChatSessionSummary): string {
  return DETAIL_HREF_BUILDERS[source](summary);
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

async function collectIndexedClaude(
  db: Database.Database
): Promise<{ sessions: DashboardCollectorSession[]; diagnostics: DashboardDiagnostic[] }> {
  const rows = listClaudeDashboardSessions(db, {});
  const sessions: DashboardCollectorSession[] = rows.map((r) => ({
    source: "claude-code",
    summary: {
      id: r.sessionId,
      index: 0,
      title: r.title,
      createdAt: r.createdAt ? new Date(r.createdAt) : new Date(r.lastUpdatedAt),
      lastUpdatedAt: new Date(r.lastUpdatedAt),
      messageCount: r.messageCount ?? 0,
      workspaceId: r.projectId,
      workspacePath: r.projectPath,
      preview: r.preview ?? "",
      source: "claude-code",
      metadata: {
        indexed: {
          key: r.projectKey,
          path: r.projectPath,
          confidence: r.identityConfidence,
        },
      },
    },
    decodedWorkspacePath: r.projectPath,
  }));
  return { sessions, diagnostics: [] };
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

/**
 * kimi 的会话收集器。身份直接沿用 token 索引里算好的 project_key/path
 * (走 metadata.indexed),这样看板的项目行与 token 查询聚合在**同一个键**上,
 * 不会因为两处各自 normalize 而漂移 —— 与 collectIndexedClaude 同一个做法。
 */
function collectIndexedKimi(db: Database.Database): {
  sessions: DashboardCollectorSession[];
  diagnostics: DashboardDiagnostic[];
} {
  const { sessions: rows, diagnostics: raw } = listKimiDashboardSessions(db);
  const sessions: DashboardCollectorSession[] = rows.map((r, index) => ({
    source: "kimi",
    summary: {
      id: r.sessionId,
      index,
      title: r.title,
      createdAt: new Date(r.createdAt),
      lastUpdatedAt: new Date(r.lastUpdatedAt),
      // 数的是真人提问 —— 见 kimiHistory/sessions.ts 顶部关于计数单位的说明。
      messageCount: r.humanMessageCount,
      workspaceId: r.projectKey,
      workspacePath: r.projectPath,
      preview: r.preview,
      source: "kimi",
      metadata: {
        indexed: {
          key: r.projectKey,
          path: r.projectPath,
          confidence: r.identityConfidence,
        },
        model: r.model,
        agentCount: r.agentCount,
        totalMessageCount: r.totalMessageCount,
      },
    },
    decodedWorkspacePath: r.projectPath,
  }));
  return {
    sessions,
    diagnostics: raw.map((d) => ({
      source: "kimi" as const,
      severity: "warning" as const,
      kind: d.kind,
      message: d.message,
      count: d.count,
    })),
  };
}

async function collectDefaultOpencode(): Promise<{
  sessions: DashboardCollectorSession[];
  diagnostics: DashboardDiagnostic[];
}> {
  try {
    // opencode list is a single SQLite read (bounded by stateDb's own LIMIT);
    // exclude archived to match the token query's `time_archived IS NULL`.
    const result = await listOpencodeSessionSummaries(undefined, { archived: false });
    // A missing opencode.db means the user doesn't use opencode — a normal state
    // for most users of a default source, not a warning. Drop it (surface only
    // real problems like schema incompatibility).
    const diagnostics: DashboardDiagnostic[] = result.diagnostics
      .filter((d) => d.kind !== "db-not-found")
      .map((d) => ({
        source: "opencode",
        severity: "warning",
        kind: d.kind,
        message: d.message,
        path: d.path,
        count: d.count,
      }));
    return {
      // summary.workspacePath is the session directory → same canonical key the
      // token query aggregates under, so opencode merges with claude/codex.
      sessions: result.sessions.map((summary) => ({
        source: "opencode",
        summary: { ...summary, source: "opencode" },
        decodedWorkspacePath: summary.workspacePath,
      })),
      diagnostics,
    };
  } catch (e) {
    return {
      sessions: [],
      diagnostics: [{
        source: "opencode",
        severity: "error",
        kind: "source-unavailable",
        message: e instanceof Error ? e.message : String(e),
      }],
    };
  }
}

export function defaultDashboardCollectors(db?: Database.Database): DashboardCollectors {
  return {
    // When a DB is available, read the Claude session list from the token
    // index (no transcript parsing); fall back to file parsing without a DB.
    listClaude: db ? () => collectIndexedClaude(db) : collectDefaultClaude,
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
    // opencode token/status query its own opencode.db (not the index db), so
    // these are wired regardless of `db`.
    listOpencode: collectDefaultOpencode,
    listOpencodeProjectTokenUsage: async ({ projectKeys, from }) =>
      listOpencodeProjectTokenUsage(undefined, { projectKeys, from }),
    listKimi: db ? async () => collectIndexedKimi(db) : undefined,
    listKimiProjectTokenUsage: db
      ? async ({ projectKeys, from }) => listKimiProjectTokenUsage(db, { projectKeys, from })
      : undefined,
    getKimiTokenUsageStatus: db
      ? async () => getKimiTokenUsageStatus(db)
      : undefined,
    getOpencodeTokenUsageStatus: async () => getOpencodeTokenUsageStatus(undefined),
    listWorkProjectDurationUsage: db
      ? async ({ projectKeys, from, sources }) =>
          // Duration is a separate round with its own claude|codex union — drop
          // opencode at the boundary rather than passing it an unknown source.
          listWorkProjectDurationUsage(db, {
            projectKeys,
            from,
            sources: sources.filter(
              (source): source is WorkDurationSource =>
                source === "claude-code" || source === "codex"
            ),
          })
      : undefined,
  };
}

/**
 * The common shape every per-source indexed token map exposes (Claude/Codex/…
 * all structurally satisfy this). Kept read-only so a narrower source map
 * (e.g. `Map<string, ClaudeProjectTokenUsage>`) stays covariantly assignable.
 */
type IndexedProjectUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  coveredSessions: number;
  totalSessions: number;
  coverage: "full" | "partial" | "unknown";
};

type IndexedUsageBySource = Partial<
  Record<DashboardSource, ReadonlyMap<string, IndexedProjectUsage> | undefined>
>;

// Per-source transcript loader. Only sources whose sessions must be file-scanned
// need an entry; indexed-only sources are absent (they never reach the scan loop).
const SESSION_DETAIL_LOADERS: Partial<
  Record<
    DashboardSource,
    (
      collectors: DashboardCollectors,
      session: DashboardSession
    ) => Promise<ChatSession | null>
  >
> = {
  "claude-code": (collectors, session) =>
    collectors.loadClaudeDetail(session.raw.workspaceId, session.id),
  codex: (collectors, session) => collectors.loadCodexDetail(session.id),
};

async function applyTokenUsage(
  project: DashboardProject,
  collectors: DashboardCollectors,
  diagnostics: DashboardDiagnostic[],
  scanLimit: number,
  indexedBySource: IndexedUsageBySource
): Promise<void> {
  const indexedForProject = (source: DashboardSource): IndexedProjectUsage | undefined =>
    indexedBySource[source]?.get(project.key);
  // Only file-scan sessions whose SOURCE has no index. Indexed sources are
  // summed from the DB instead of re-reading transcripts (when every present
  // source is indexed, `toScan` is empty → zero transcript reads).
  const toScan = project.recentSessions
    .filter((session) => !indexedForProject(session.source))
    .slice(0, scanLimit);

  let inputTokens = 0;
  let outputTokens = 0;
  let coveredSessions = 0;

  for (const session of toScan) {
    let detail: ChatSession | null = null;
    try {
      const loader = SESSION_DETAIL_LOADERS[session.source];
      detail = loader ? await loader(collectors, session) : null;
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
  }

  // Fold every source: an indexed source contributes its DB sums + indexed
  // session count; a non-indexed source contributes that source's session count
  // on this project and flags truncation when it exceeds the scan budget.
  let anyIndexPartial = false;
  let totalSessions = 0;
  let indexedScanned = 0;
  let truncated = false;
  // 只登记**真正贡献了计数**的源的单位 —— 注册了但这个项目下没有数据的源
  // 不该把单位打成 mixed。
  const breakdown: DashboardCoverageBreakdown = {};
  const bump = (source: DashboardSource, covered: number, total: number): void => {
    if (total <= 0) return;
    const unit = SOURCE_COVERAGE_UNITS[source];
    const slot = (breakdown[unit] ??= { covered: 0, total: 0 });
    slot.covered += covered;
    slot.total += total;
  };
  for (const source of DASHBOARD_SOURCES) {
    const idx = indexedForProject(source);
    if (idx) {
      inputTokens += idx.inputTokens;
      outputTokens += idx.outputTokens;
      coveredSessions += idx.coveredSessions;
      if (idx.coverage === "partial") anyIndexPartial = true;
      totalSessions += idx.totalSessions;
      indexedScanned += idx.totalSessions;
      bump(source, idx.coveredSessions, idx.totalSessions);
    } else {
      // 没有索引的源:这个项目下该源的会话数进分母,覆盖数由上面的逐场扫描累加,
      // 无法按源拆分 —— 所以小计里只记分母,covered 记 0(宁可少算不可多算)。
      const count = project.sourceCounts[source];
      totalSessions += count;
      if (count > scanLimit) truncated = true;
      bump(source, 0, count);
    }
  }
  // 只登记**真正贡献了计数**的源的单位 —— 注册了但这个项目下没有数据的源
  // 不该把单位打成 mixed。
  const units = Object.keys(breakdown) as ("session" | "agent")[];
  const coverageUnit: DashboardCoverageUnit =
    units.length === 0 ? null : units.length > 1 ? "mixed" : units[0];

  project.tokenUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    coverage:
      coveredSessions === 0
        ? "unknown"
        : anyIndexPartial
          ? "partial"
          : coveredSessions === totalSessions && !truncated
            ? "full"
            : "partial",
    coverageUnit,
    coverageBreakdown: breakdown,
    coveredSessions,
    totalSessions,
    scannedSessions: indexedScanned + toScan.length,
    scanLimit,
    truncated,
  };
  if (truncated) {
    diagnostics.push({
      source:
        DASHBOARD_SOURCES.find((source) => project.sourceCounts[source] > 0) ??
        DASHBOARD_SOURCES[0],
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
    // 总计的单位由各项目的单位合并而来:只要有两种不同的单位出现,总计就是 mixed。
    for (const [unit, slot] of Object.entries(project.tokenUsage.coverageBreakdown)) {
      const key = unit as "session" | "agent";
      const into = (out.coverageBreakdown[key] ??= { covered: 0, total: 0 });
      into.covered += slot.covered;
      into.total += slot.total;
    }
  }
  const outUnits = Object.keys(out.coverageBreakdown) as ("session" | "agent")[];
  out.coverageUnit =
    outUnits.length === 0 ? null : outUnits.length > 1 ? "mixed" : outUnits[0];
  if (out.coveredSessions === 0) out.coverage = "unknown";
  return out;
}

type IndexedCodexUsage = Awaited<ReturnType<NonNullable<DashboardCollectors["listCodexProjectTokenUsage"]>>>;
type IndexedClaudeUsage = Awaited<ReturnType<NonNullable<DashboardCollectors["listClaudeProjectTokenUsage"]>>>;
type IndexedOpencodeUsage = Awaited<ReturnType<NonNullable<DashboardCollectors["listOpencodeProjectTokenUsage"]>>>;
type IndexedKimiUsage = Awaited<ReturnType<NonNullable<DashboardCollectors["listKimiProjectTokenUsage"]>>>;

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
  if (options.sources.includes("opencode") && deps.listOpencode) {
    const res = await deps.listOpencode();
    collected.push(...res.sessions);
    diagnostics.push(...res.diagnostics);
  }
  if (options.sources.includes("kimi") && deps.listKimi) {
    // 这一块决定了「只有 kimi 活动的项目」能不能被发现 —— 总览页的项目行是按
    // session 建的,没有会话收集器时 meng1 / gongren-pipeline 这类项目
    // 永远进不了列表(哪怕它们的 token 已经进了排行页)。
    const res = await deps.listKimi();
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
  let indexedClaudeByProject: IndexedClaudeUsage | undefined;
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
      indexedClaudeByProject = await deps.listClaudeProjectTokenUsage({
        projectKeys: projects.map((project) => project.key),
        from: range.from,
      });
    } catch (e) {
      diagnostics.push({
        source: "claude-code",
        severity: "warning",
        kind: "claude-token-index-unavailable",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  let indexedOpencodeByProject: IndexedOpencodeUsage | undefined;
  if (options.sources.includes("opencode") && deps.listOpencodeProjectTokenUsage) {
    try {
      const status = deps.getOpencodeTokenUsageStatus
        ? await deps.getOpencodeTokenUsageStatus()
        : null;
      if (status && !status.fresh) {
        diagnostics.push({
          source: "opencode",
          severity: "warning",
          kind: "opencode-token-index-stale",
          message: `opencode token data is stale: ${status.staleReasons.join(", ")}`,
        });
      }
      indexedOpencodeByProject = await deps.listOpencodeProjectTokenUsage({
        projectKeys: projects.map((project) => project.key),
        from: range.from,
      });
    } catch (e) {
      diagnostics.push({
        source: "opencode",
        severity: "warning",
        kind: "opencode-token-index-unavailable",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  let indexedKimiByProject: IndexedKimiUsage | undefined;
  if (options.sources.includes("kimi") && deps.listKimiProjectTokenUsage) {
    try {
      const status = deps.getKimiTokenUsageStatus
        ? await deps.getKimiTokenUsageStatus()
        : null;
      if (status && !status.fresh) {
        diagnostics.push({
          source: "kimi",
          severity: "warning",
          kind: "kimi-token-index-stale",
          message: `kimi token index is stale: ${status.staleReasons.join(", ")}`,
          count: status.state?.indexed_agent_count,
        });
      }
      indexedKimiByProject = await deps.listKimiProjectTokenUsage({
        projectKeys: projects.map((project) => project.key),
        from: range.from,
      });
    } catch (e) {
      diagnostics.push({
        source: "kimi",
        severity: "warning",
        kind: "kimi-token-index-unavailable",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  } else if (options.sources.includes("kimi")) {
    // 点了 kimi 却没有收集器 —— 说出来。原先这里什么都不做,于是
    // 「请求了这个源」与「这个源没数据」在页面上长得一模一样。
    diagnostics.push({
      source: "kimi",
      severity: "warning",
      kind: "kimi-token-index-unavailable",
      message: "kimi token index is not configured",
    });
  }
  const indexedUsageBySource: IndexedUsageBySource = {
    "claude-code": indexedClaudeByProject,
    codex: indexedCodexByProject,
    opencode: indexedOpencodeByProject,
    kimi: indexedKimiByProject,
  };
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
      indexedUsageBySource
    );
    project.recentSessions = project.recentSessions.slice(0, options.sessionsPerProject);
  }

  const totalsSourceCounts = sourceCounts();
  for (const project of projects) {
    for (const source of DASHBOARD_SOURCES) {
      totalsSourceCounts[source] += project.sourceCounts[source];
    }
  }

  return {
    ok: true,
    generatedAt: now,
    range,
    sources: options.sources,
    availableSources: [...DASHBOARD_SOURCES],
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

  if (options.sources.includes("opencode") && deps.listOpencodeProjectTokenUsage) {
    try {
      const status = deps.getOpencodeTokenUsageStatus
        ? await deps.getOpencodeTokenUsageStatus()
        : null;
      if (status && !status.fresh) {
        diagnostics.push({
          source: "opencode",
          severity: "warning",
          kind: "opencode-token-index-stale",
          message: `opencode token data is stale: ${status.staleReasons.join(", ")}`,
        });
      }
      const opencodeUsage = await deps.listOpencodeProjectTokenUsage({
        projectKeys: [],
        from: range.from,
      });
      for (const usage of opencodeUsage.values()) {
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
        source: "opencode",
        severity: "warning",
        kind: "opencode-token-index-unavailable",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  } else if (options.sources.includes("opencode")) {
    diagnostics.push({
      source: "opencode",
      severity: "warning",
      kind: "opencode-token-index-unavailable",
      message: "opencode token index is not configured",
    });
  }

  // kimi。这个块是 T12 漏掉的那个 —— 当时只在 buildWorkDashboard 里加了 kimi,
  // 而排行页是与它**并列的独立函数**,里面 kimi 出现 0 次,于是只有 kimi 活动的
  // 项目(meng1、gongren-pipeline)根本不在榜上。
  // 计数单位是 agent 文件,不是 session(见 KimiProjectTokenUsage)。
  if (options.sources.includes("kimi") && deps.listKimiProjectTokenUsage) {
    try {
      const status = deps.getKimiTokenUsageStatus
        ? await deps.getKimiTokenUsageStatus()
        : null;
      if (status && !status.fresh) {
        diagnostics.push({
          source: "kimi",
          severity: "warning",
          kind: "kimi-token-index-stale",
          message: `kimi token index is stale: ${status.staleReasons.join(", ")}`,
          count: status.state?.indexed_agent_count,
        });
      }
      const kimiUsage = await deps.listKimiProjectTokenUsage({
        projectKeys: [],
        from: range.from,
      });
      for (const usage of kimiUsage.values()) {
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
        source: "kimi",
        severity: "warning",
        kind: "kimi-token-index-unavailable",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  } else if (options.sources.includes("kimi")) {
    diagnostics.push({
      source: "kimi",
      severity: "warning",
      kind: "kimi-token-index-unavailable",
      message: "kimi token index is not configured",
    });
  }

  const labelCounts = new Map<string, number>();
  const rankedProjects = [...projectsByKey.values()]
    .sort((a, b) =>
      b.totalTokens - a.totalTokens ||
      b.lastUpdatedAt.getTime() - a.lastUpdatedAt.getTime()
    )
    .slice(0, options.limit);
  let durationByProject = new Map<string, { activeMs: number }>();
  if (deps.listWorkProjectDurationUsage && rankedProjects.length > 0) {
    try {
      durationByProject = await deps.listWorkProjectDurationUsage({
        projectKeys: rankedProjects.map((project) => project.key),
        from: range.from,
        sources: options.sources,
      });
    } catch (e) {
      diagnostics.push({
        source: options.sources[0] ?? "codex",
        severity: "warning",
        kind: "work-duration-index-unavailable",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const projects: WorkTokenRankingProject[] = rankedProjects
    .map((project) => ({
      key: project.key,
      label: projectLabel(project.path, labelCounts),
      path: project.path,
      totalTokens: project.totalTokens,
      activeMs: durationByProject.get(project.key)?.activeMs ?? 0,
    }));

  return {
    ok: true,
    generatedAt: now,
    range,
    sources: options.sources,
    availableSources: [...DASHBOARD_SOURCES],
    diagnostics,
    projects,
  };
}
