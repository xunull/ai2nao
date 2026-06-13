import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeSession } from "../src/claudeCodeHistory/normalize.js";
import { parseJsonlText } from "../src/localJsonl/parse.js";

/**
 * Regression: mapTokenUsage was reading only `input_tokens` and `output_tokens`,
 * silently dropping `cache_creation_input_tokens` + `cache_read_input_tokens`.
 *
 * For Claude Code with prompt caching enabled (the default), the headline
 * `input_tokens` is just the new bytes this turn (often <100); the bulk of
 * billed prompt size sits in `cache_creation_input_tokens` (fresh cache write)
 * and `cache_read_input_tokens` (replay). Long sessions can be 100-1000x larger
 * than what the old code reported, which made the Token 排行/趋势 page show
 * Codex >> Claude even when the user clearly used Claude Code more.
 *
 * Bug surfaced 2026-06-12 via /investigate. Fix: sum all three input components.
 */
describe("Claude Code token usage — prompt cache fields (regression)", () => {
  function writeTranscript(lines: object[]): string {
    const dir = mkdtempSync(join(tmpdir(), "ai2nao-claude-cache-"));
    const file = join(dir, "transcript.jsonl");
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
    return file;
  }

  function sessionFromRecords(records: object[]) {
    const file = writeTranscript(records);
    const text = readFileSync(file, "utf8");
    const parsed = parseJsonlText(text);
    return buildClaudeSession({
      projectId: "test-project",
      sessionId: "test-session",
      parse: parsed,
      fileMtimeMs: Date.now(),
    });
  }

  it("includes cache_creation_input_tokens + cache_read_input_tokens in totalInputTokens", () => {
    const session = sessionFromRecords([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          usage: {
            input_tokens: 6,
            cache_creation_input_tokens: 47655,
            cache_read_input_tokens: 22924,
            output_tokens: 252,
          },
        },
      },
    ]);
    expect(session.session.usage).toBeDefined();
    // 6 + 47655 + 22924 = 70585 input total
    expect(session.session.usage?.totalInputTokens).toBe(70585);
    expect(session.session.usage?.totalOutputTokens).toBe(252);
  });

  it("treats missing cache fields as 0 (back-compat with older transcripts)", () => {
    const session = sessionFromRecords([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    ]);
    expect(session.session.usage?.totalInputTokens).toBe(100);
    expect(session.session.usage?.totalOutputTokens).toBe(50);
  });

  it("sums cache fields across multiple assistant messages", () => {
    const session = sessionFromRecords([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "turn 1" }],
          usage: {
            input_tokens: 5,
            cache_creation_input_tokens: 30000,
            cache_read_input_tokens: 0,
            output_tokens: 100,
          },
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "turn 2" }],
          usage: {
            input_tokens: 8,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 30000,
            output_tokens: 200,
          },
        },
      },
    ]);
    // turn 1: 5 + 30000 + 0 = 30005
    // turn 2: 8 + 2000 + 30000 = 32008
    // sum: 62013
    expect(session.session.usage?.totalInputTokens).toBe(62013);
    expect(session.session.usage?.totalOutputTokens).toBe(300);
  });
});
