import { describe, expect, it } from "vitest";
import { dashboardResponseToJson } from "../src/workDashboard/json.js";
import type { WorkDashboardResponse } from "../src/workDashboard/types.js";

describe("workDashboard json", () => {
  it("serializes Date fields and preserves diagnostics/token metadata", () => {
    const response: WorkDashboardResponse = {
      ok: true,
      generatedAt: new Date("2026-06-07T00:00:00.000Z"),
      range: {
        from: new Date("2026-06-01T00:00:00.000Z"),
        to: new Date("2026-06-07T00:00:00.000Z"),
        days: 7,
      },
      diagnostics: [{
        source: "codex",
        severity: "warning",
        kind: "token-scan-truncated",
        message: "bounded",
        count: 3,
      }],
      totals: {
        projectCount: 1,
        sessionCount: 1,
        sourceCounts: { "claude-code": 0, codex: 1, opencode: 0 },
        tokenUsage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          coverage: "partial",
          coveredSessions: 1,
          totalSessions: 2,
          scannedSessions: 1,
          scanLimit: 1,
          truncated: true,
        },
      },
      projects: [{
        key: "/repo",
        label: "repo",
        path: "/repo",
        identityConfidence: "high",
        lastUpdatedAt: new Date("2026-06-06T00:00:00.000Z"),
        sessionCount: 1,
        sourceCounts: { "claude-code": 0, codex: 1, opencode: 0 },
        tokenUsage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          coverage: "partial",
          coveredSessions: 1,
          totalSessions: 2,
          scannedSessions: 1,
          scanLimit: 1,
          truncated: true,
        },
        recentSessions: [{
          id: "s1",
          source: "codex",
          projectKey: "/repo",
          projectPath: "/repo",
          identityConfidence: "high",
          title: "title",
          preview: "preview",
          createdAt: new Date("2026-06-06T00:00:00.000Z"),
          lastUpdatedAt: new Date("2026-06-06T01:00:00.000Z"),
          messageCount: 2,
          detailHref: "/codex-history/s/s1",
          raw: {
            id: "s1",
            index: 0,
            title: "title",
            createdAt: new Date("2026-06-06T00:00:00.000Z"),
            lastUpdatedAt: new Date("2026-06-06T01:00:00.000Z"),
            messageCount: 2,
            workspaceId: "/repo",
            workspacePath: "/repo",
            preview: "preview",
          },
        }],
      }],
    };

    const json = dashboardResponseToJson(response);
    expect(json.generatedAt).toBe("2026-06-07T00:00:00.000Z");
    expect(json.range.from).toBe("2026-06-01T00:00:00.000Z");
    expect(json.projects[0].lastUpdatedAt).toBe("2026-06-06T00:00:00.000Z");
    expect(json.projects[0].recentSessions[0].lastUpdatedAt).toBe("2026-06-06T01:00:00.000Z");
    expect(json.diagnostics[0]).toMatchObject({ source: "codex", kind: "token-scan-truncated", count: 3 });
    expect(json.totals.tokenUsage.truncated).toBe(true);
  });
});
