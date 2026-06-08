import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { refreshClaudeTokenUsage } from "../src/claudeTokenUsage/refresh.js";
import {
  getClaudeTokenUsageStatus,
  listClaudeProjectTokenUsage,
} from "../src/claudeTokenUsage/queries.js";
import { openDatabase } from "../src/store/open.js";

function makeFixture() {
  const base = join(tmpdir(), `ai2nao-claude-token-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const projectsRoot = join(base, "projects");
  const projectDir = join(projectsRoot, "-work-app");
  mkdirSync(projectDir, { recursive: true });
  const indexDb = openDatabase(join(base, "index.db"));
  return { projectsRoot, projectDir, indexDb };
}

function transcript(input: number, output: number, cwd = "/work/app") {
  return [
    JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-04-26T00:00:00.000Z",
      sessionId: "sid",
      cwd,
      message: { role: "user", content: "hello" },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-04-26T00:00:02.000Z",
      sessionId: "sid",
      cwd,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "world" }],
        usage: { input_tokens: input, output_tokens: output },
      },
    }),
  ].join("\n");
}

describe("claude token usage refresh", () => {
  it("indexes all Claude project transcripts and aggregates token usage by project", async () => {
    const { projectsRoot, projectDir, indexDb } = makeFixture();
    try {
      writeFileSync(join(projectDir, "s1.jsonl"), transcript(10, 5), "utf8");
      writeFileSync(join(projectDir, "s2.jsonl"), transcript(20, 7), "utf8");

      const result = await refreshClaudeTokenUsage(indexDb, { projectsRoot });
      expect(result).toMatchObject({
        status: "success",
        sourceSessionCount: 2,
        indexedSessionCount: 2,
        tokenKnownSessionCount: 2,
      });
      const usage = [...listClaudeProjectTokenUsage(indexDb, {
        projectKeys: [],
        from: null,
      }).values()][0];
      expect(usage).toMatchObject({
        projectPath: "/work/app",
        inputTokens: 30,
        outputTokens: 12,
        totalTokens: 42,
        coveredSessions: 2,
        totalSessions: 2,
        coverage: "full",
      });
      expect(getClaudeTokenUsageStatus(indexDb).fresh).toBe(true);
    } finally {
      indexDb.close();
    }
  });

  it("skips unchanged transcripts and reparses changed files", async () => {
    const { projectsRoot, projectDir, indexDb } = makeFixture();
    try {
      const file = join(projectDir, "s1.jsonl");
      writeFileSync(file, transcript(10, 5), "utf8");

      await refreshClaudeTokenUsage(indexDb, { projectsRoot });
      const skipped = await refreshClaudeTokenUsage(indexDb, { projectsRoot });
      expect(skipped.skippedUnchangedCount).toBe(1);

      writeFileSync(file, transcript(30, 9) + "\n", "utf8");
      const reparsed = await refreshClaudeTokenUsage(indexDb, { projectsRoot });
      expect(reparsed.skippedUnchangedCount).toBe(0);
      const usage = [...listClaudeProjectTokenUsage(indexDb, {
        projectKeys: [],
        from: null,
      }).values()][0];
      expect(usage).toMatchObject({ inputTokens: 30, outputTokens: 9 });
    } finally {
      indexDb.close();
    }
  });

  it("marks sessions without assistant usage as unknown instead of estimating", async () => {
    const { projectsRoot, projectDir, indexDb } = makeFixture();
    try {
      writeFileSync(
        join(projectDir, "s1.jsonl"),
        JSON.stringify({
          type: "user",
          uuid: "u1",
          timestamp: "2026-04-26T00:00:00.000Z",
          sessionId: "sid",
          cwd: "/work/app",
          message: { role: "user", content: "hello" },
        }),
        "utf8"
      );

      await refreshClaudeTokenUsage(indexDb, { projectsRoot });
      const usage = [...listClaudeProjectTokenUsage(indexDb, {
        projectKeys: [],
        from: null,
      }).values()][0];
      expect(usage).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        coveredSessions: 0,
        totalSessions: 1,
        coverage: "unknown",
      });
    } finally {
      indexDb.close();
    }
  });
});
