import type {
  DashboardProject,
  DashboardSession,
  WorkTokenRankingResponse,
  WorkDashboardResponse,
} from "./types.js";

export function dashboardSessionToJson(s: DashboardSession) {
  return {
    id: s.id,
    source: s.source,
    projectKey: s.projectKey,
    projectPath: s.projectPath,
    identityConfidence: s.identityConfidence,
    title: s.title,
    preview: s.preview,
    createdAt: s.createdAt.toISOString(),
    lastUpdatedAt: s.lastUpdatedAt.toISOString(),
    messageCount: s.messageCount,
    tokenUsage: s.tokenUsage,
    model: s.model,
    gitBranch: s.gitBranch,
    detailHref: s.detailHref,
  };
}

export function dashboardProjectToJson(p: DashboardProject) {
  return {
    key: p.key,
    label: p.label,
    path: p.path,
    identityConfidence: p.identityConfidence,
    lastUpdatedAt: p.lastUpdatedAt.toISOString(),
    sessionCount: p.sessionCount,
    sourceCounts: p.sourceCounts,
    tokenUsage: p.tokenUsage,
    recentSessions: p.recentSessions.map(dashboardSessionToJson),
  };
}

export function dashboardResponseToJson(r: WorkDashboardResponse) {
  return {
    ok: true,
    generatedAt: r.generatedAt.toISOString(),
    range: {
      from: r.range.from ? r.range.from.toISOString() : null,
      to: r.range.to.toISOString(),
      days: r.range.days,
    },
    diagnostics: r.diagnostics,
    totals: r.totals,
    projects: r.projects.map(dashboardProjectToJson),
  };
}

export function tokenRankingResponseToJson(r: WorkTokenRankingResponse) {
  return {
    ok: true,
    generatedAt: r.generatedAt.toISOString(),
    range: {
      from: r.range.from ? r.range.from.toISOString() : null,
      to: r.range.to.toISOString(),
      months: r.range.months,
    },
    sources: r.sources,
    diagnostics: r.diagnostics,
    projects: r.projects,
  };
}
