import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { refreshClaudeTokenUsage } from "../src/claudeTokenUsage/refresh.js";
import {
  getClaudeTokenUsageRow,
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

function transcript(
  input: number,
  output: number,
  cwd = "/work/app",
  cache?: { read: number; creation: number }
) {
  const usage: Record<string, number> = {
    input_tokens: input,
    output_tokens: output,
  };
  if (cache) {
    usage.cache_read_input_tokens = cache.read;
    usage.cache_creation_input_tokens = cache.creation;
  }
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
        usage,
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

  it("v3: persists cache_read / cache_creation columns into the row", async () => {
    const { projectsRoot, projectDir, indexDb } = makeFixture();
    try {
      // input_tokens=6 fresh, cache write 47655, cache read 22924
      writeFileSync(
        join(projectDir, "s1.jsonl"),
        transcript(6, 252, "/work/app", { read: 22924, creation: 47655 }),
        "utf8"
      );
      await refreshClaudeTokenUsage(indexDb, { projectsRoot });

      const row = getClaudeTokenUsageRow(indexDb, "-work-app:s1");
      expect(row).not.toBeNull();
      // fused input = 6 + 47655 + 22924 = 70585
      expect(row!.input_tokens).toBe(70585);
      expect(row!.cache_read_input_tokens).toBe(22924);
      expect(row!.cache_creation_input_tokens).toBe(47655);
      // 真实新增 = input - read - creation = 6
      expect(
        row!.input_tokens -
          row!.cache_read_input_tokens -
          row!.cache_creation_input_tokens
      ).toBe(6);
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
