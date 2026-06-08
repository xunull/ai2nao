import { describe, expect, it } from "vitest";
import type { ChatSession, ChatSessionSummary } from "../src/cursorHistory/types.js";
import {
  buildWorkTokenRanking,
  buildWorkDashboard,
  normalizeDashboardOptions,
  normalizeDashboardProjectPath,
} from "../src/workDashboard/aggregate.js";
import type { DashboardCollectors } from "../src/workDashboard/types.js";

function summary(
  id: string,
  source: "claude-code" | "codex",
  workspacePath: string,
  lastUpdatedAt: string
): ChatSessionSummary {
  return {
    id,
    index: 0,
    title: `${source} ${id}`,
    createdAt: new Date(lastUpdatedAt),
    lastUpdatedAt: new Date(lastUpdatedAt),
    messageCount: 2,
    workspaceId: workspacePath,
    workspacePath,
    preview: `preview ${id}`,
    source,
    metadata: source === "codex" ? { codex: { cwd: workspacePath } } : undefined,
  };
}

function detail(id: string, workspacePath: string, input = 10, output = 5): ChatSession {
  return {
    id,
    index: 0,
    title: id,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    lastUpdatedAt: new Date("2026-06-01T00:00:00.000Z"),
    messageCount: 2,
    messages: [],
    workspaceId: workspacePath,
    workspacePath,
    usage: { totalInputTokens: input, totalOutputTokens: output },
  };
}

function collectors(overrides: Partial<DashboardCollectors> = {}): DashboardCollectors {
  const root = process.cwd();
  return {
    listClaude: async () => ({
      diagnostics: [],
      sessions: [
        { source: "claude-code", summary: summary("c1", "claude-code", root, "2026-06-06T00:00:00.000Z") },
      ],
    }),
    listCodex: async () => ({
      diagnostics: [],
      sessions: [
        { source: "codex", summary: summary("x1", "codex", root, "2026-06-06T00:05:00.000Z") },
      ],
    }),
    loadClaudeDetail: async (_projectId, sessionId) => detail(sessionId, root, 100, 50),
    loadCodexDetail: async (sessionId) => detail(sessionId, root, 20, 10),
    ...overrides,
  };
}

describe("workDashboard aggregate", () => {
  it("merges Claude and Codex sessions by canonical project path and sorts by latest activity", async () => {
    const dashboard = await buildWorkDashboard(
      { rangeDays: 30 },
      collectors(),
      new Date("2026-06-07T00:00:00.000Z")
    );
    expect(dashboard.projects).toHaveLength(1);
    expect(dashboard.projects[0].sourceCounts).toEqual({ "claude-code": 1, codex: 1 });
    expect(dashboard.projects[0].recentSessions.map((s) => s.id)).toEqual(["x1", "c1"]);
    expect(dashboard.projects[0].tokenUsage).toMatchObject({
      inputTokens: 120,
      outputTokens: 60,
      coverage: "full",
      coveredSessions: 2,
    });
  });

  it("filters to the requested source and date range", async () => {
    const dashboard = await buildWorkDashboard(
      { rangeDays: 7, sources: ["codex"] },
      collectors(),
      new Date("2026-06-07T00:00:00.000Z")
    );
    expect(dashboard.projects[0].sourceCounts).toEqual({ "claude-code": 0, codex: 1 });
    expect(dashboard.totals.sessionCount).toBe(1);
  });

  it("marks token coverage partial when token detail scanning is bounded", async () => {
    const root = process.cwd();
    const dashboard = await buildWorkDashboard(
      { tokenSessionsPerProject: 1, sessionsPerProject: 2 },
      collectors({
        listClaude: async () => ({
          diagnostics: [],
          sessions: [
            { source: "claude-code", summary: summary("c1", "claude-code", root, "2026-06-06T00:00:00.000Z") },
            { source: "claude-code", summary: summary("c2", "claude-code", root, "2026-06-06T00:02:00.000Z") },
          ],
        }),
        listCodex: async () => ({ diagnostics: [], sessions: [] }),
      }),
      new Date("2026-06-07T00:00:00.000Z")
    );
    expect(dashboard.projects[0].tokenUsage).toMatchObject({
      coverage: "partial",
      scannedSessions: 1,
      scanLimit: 1,
      truncated: true,
    });
    expect(dashboard.diagnostics.some((d) => d.kind === "token-scan-truncated")).toBe(true);
  });

  it("keeps dashboard partial when one source fails", async () => {
    const dashboard = await buildWorkDashboard(
      {},
      collectors({
        listClaude: async () => ({
          sessions: [],
          diagnostics: [{ source: "claude-code", severity: "error", kind: "source-unavailable", message: "missing" }],
        }),
      }),
      new Date("2026-06-07T00:00:00.000Z")
    );
    expect(dashboard.projects).toHaveLength(1);
    expect(dashboard.projects[0].sourceCounts.codex).toBe(1);
    expect(dashboard.diagnostics.some((d) => d.kind === "source-unavailable")).toBe(true);
  });

  it("normalizes fallback project identity as low confidence when path is unavailable", () => {
    const s = summary("s1", "claude-code", "not-a-real-path", "2026-06-06T00:00:00.000Z");
    const identity = normalizeDashboardProjectPath("claude-code", s);
    expect(identity).toEqual({
      key: "claude-code:not-a-real-path",
      path: "not-a-real-path",
      confidence: "low",
    });
  });

  it("clamps scan limits to accepted maximums", () => {
    const options = normalizeDashboardOptions({
      tokenSessionsPerProject: 999,
      claudeSessionsPerProject: 999,
      codexFallbackFiles: 99999,
    });
    expect(options.tokenSessionsPerProject).toBe(20);
    expect(options.claudeSessionsPerProject).toBe(100);
    expect(options.codexFallbackFiles).toBe(5000);
  });

  it("builds token ranking by combining indexed Codex and Claude usage", async () => {
    const root = process.cwd();
    const other = `${root}/other-project`;
    const ranking = await buildWorkTokenRanking(
      { rangeMonths: 6 },
      collectors({
        listClaudeProjectTokenUsage: async () => new Map([
          [root, {
            projectKey: root,
            projectPath: root,
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            coveredSessions: 1,
            totalSessions: 1,
            errorSessions: 0,
            coverage: "full",
          }],
          [other, {
            projectKey: other,
            projectPath: other,
            inputTokens: 5,
            outputTokens: 5,
            totalTokens: 10,
            coveredSessions: 1,
            totalSessions: 1,
            errorSessions: 0,
            coverage: "full",
          }],
        ]),
        getClaudeTokenUsageStatus: async () => ({ state: null, fresh: true, staleReasons: [] }),
        listCodexProjectTokenUsage: async () => new Map([
          [root, {
            projectKey: root,
            projectPath: root,
            inputTokens: 20,
            outputTokens: 10,
            totalTokens: 30,
            coveredSessions: 1,
            totalSessions: 1,
            errorSessions: 0,
            coverage: "full",
          }],
        ]),
        getCodexTokenUsageStatus: async () => ({
          state: null,
          fresh: true,
          staleReasons: [],
        }),
        listWorkProjectDurationUsage: async () => new Map([
          [root, {
            projectKey: root,
            projectPath: root,
            activeMs: 90 * 60_000,
            wallMs: 120 * 60_000,
            knownSessions: 2,
            totalSessions: 2,
            errorSessions: 0,
            coverage: "full",
          }],
        ]),
      }),
      new Date("2026-06-07T00:00:00.000Z")
    );
    expect(ranking.projects.map((p) => [p.path, p.totalTokens])).toEqual([
      [root, 180],
      [other, 10],
    ]);
    expect(ranking.projects[0].activeMs).toBe(90 * 60_000);
  });

  it("filters token ranking by source and month range", async () => {
    const root = process.cwd();
    const ranking = await buildWorkTokenRanking(
      { rangeMonths: 1, sources: ["claude-code"] },
      collectors({
        listClaudeProjectTokenUsage: async (_args) => new Map([
          [root, {
            projectKey: root,
            projectPath: root,
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            coveredSessions: 1,
            totalSessions: 1,
            errorSessions: 0,
            coverage: "full",
          }],
        ]),
        getClaudeTokenUsageStatus: async () => ({ state: null, fresh: true, staleReasons: [] }),
        listCodexProjectTokenUsage: async () => {
          throw new Error("should not read codex when source is claude-only");
        },
      }),
      new Date("2026-06-07T00:00:00.000Z")
    );
    expect(ranking.projects).toHaveLength(1);
    expect(ranking.projects[0].totalTokens).toBe(15);
  });

  it("includes partially covered Codex index projects in token ranking", async () => {
    const root = process.cwd();
    const ranking = await buildWorkTokenRanking(
      { rangeMonths: "all", sources: ["codex"] },
      collectors({
        listClaude: async () => ({ diagnostics: [], sessions: [] }),
        listCodexProjectTokenUsage: async () => new Map([
          [root, {
            projectKey: root,
            projectPath: root,
            inputTokens: 70,
            outputTokens: 30,
            totalTokens: 100,
            coveredSessions: 1,
            totalSessions: 3,
            errorSessions: 1,
            coverage: "partial",
          }],
        ]),
        getCodexTokenUsageStatus: async () => ({
          state: {
            id: 1,
            rule_version: 1,
            last_rebuilt_at: "2026-06-07T00:00:00.000Z",
            last_error: null,
            source_session_count: 3,
            indexed_session_count: 3,
            token_known_session_count: 1,
            token_unknown_session_count: 1,
            error_session_count: 1,
            skipped_unchanged_count: 0,
            duration_ms: 1,
            updated_at: "2026-06-07T00:00:00.000Z",
          },
          fresh: true,
          staleReasons: [],
        }),
      }),
      new Date("2026-06-07T00:00:00.000Z")
    );
    expect(ranking.projects).toEqual([
      {
        key: root,
        label: "ai2nao",
        path: root,
        totalTokens: 100,
        activeMs: 0,
      },
    ]);
  });

  it("does not parse Codex session details during token ranking when the index is empty", async () => {
    const root = process.cwd();
    const ranking = await buildWorkTokenRanking(
      { rangeMonths: "all", sources: ["codex"] },
      collectors({
        listClaude: async () => ({ diagnostics: [], sessions: [] }),
        listCodexProjectTokenUsage: async () => new Map(),
        getCodexTokenUsageStatus: async () => ({
          state: null,
          fresh: false,
          staleReasons: ["not_built"],
        }),
        listCodex: async () => {
          throw new Error("ranking API must not scan Codex sessions");
        },
        loadCodexDetail: async () => {
          throw new Error("ranking API must not load Codex details");
        },
      }),
      new Date("2026-06-07T00:00:00.000Z")
    );
    expect(ranking.projects).toHaveLength(0);
    expect(ranking.diagnostics.some((d) => d.kind === "codex-token-index-stale")).toBe(true);
  });
});
