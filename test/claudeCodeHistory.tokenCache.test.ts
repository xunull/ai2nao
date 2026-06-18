import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeSession,
  extractClaudeSessionUsage,
} from "../src/claudeCodeHistory/normalize.js";
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

/**
 * v3: extractClaudeSessionUsage keeps the cache split separate so the
 * "Claude 输入构成" breakdown can show how much input is cache replay vs
 * fresh. inputTokens stays fused (input + creation + read); the cache fields
 * are subsets of it.
 */
describe("extractClaudeSessionUsage — cache split (v3)", () => {
  function usageFromRecords(records: object[]) {
    const dir = mkdtempSync(join(tmpdir(), "ai2nao-claude-cachesplit-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, records.map((l) => JSON.stringify(l)).join("\n"));
    return extractClaudeSessionUsage(parseJsonlText(readFileSync(file, "utf8")));
  }

  it("accumulates cache_read and cache_creation separately, subset of input", () => {
    const usage = usageFromRecords([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "t1" }],
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
          content: [{ type: "text", text: "t2" }],
          usage: {
            input_tokens: 8,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 30000,
            output_tokens: 200,
          },
        },
      },
    ]);
    expect(usage?.totalInputTokens).toBe(62013); // 5+30000+0 + 8+2000+30000
    expect(usage?.totalCacheReadInputTokens).toBe(30000); // 0 + 30000
    expect(usage?.totalCacheCreationInputTokens).toBe(32000); // 30000 + 2000
    // 真实新增 = input - read - creation = 62013 - 30000 - 32000 = 13
    const fresh =
      usage!.totalInputTokens! -
      usage!.totalCacheReadInputTokens! -
      usage!.totalCacheCreationInputTokens!;
    expect(fresh).toBe(13); // 5 + 8 raw input
  });

  it("missing cache fields → cache totals are 0, input == raw", () => {
    const usage = usageFromRecords([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "x" }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    ]);
    expect(usage?.totalInputTokens).toBe(100);
    expect(usage?.totalCacheReadInputTokens).toBe(0);
    expect(usage?.totalCacheCreationInputTokens).toBe(0);
  });
});

/**
 * v4 regression (2026-06-18 /investigate): Claude Code writes ONE assistant
 * JSONL line per content block (and extra lines as the response streams),
 * each repeating the SAME `message.usage`. A single API request (one
 * `message.id`) is billed once, but v1-v3 summed per line and double-counted
 * ~2x corpus-wide (mostly cache_read replay). extractClaudeSessionUsage now
 * dedupes by message.id, taking the max of each field.
 */
describe("extractClaudeSessionUsage — dedupe by message.id (v4)", () => {
  function usageFromRecords(records: object[]) {
    const dir = mkdtempSync(join(tmpdir(), "ai2nao-claude-dedupe-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, records.map((l) => JSON.stringify(l)).join("\n"));
    return extractClaudeSessionUsage(parseJsonlText(readFileSync(file, "utf8")));
  }

  it("counts a message.id once even when repeated across content-block lines", () => {
    // One assistant turn (msg_A) made 3 tool_use blocks → 3 jsonl lines, each
    // carrying the identical usage. Must count once, NOT 3x.
    const sameUsage = {
      input_tokens: 10,
      cache_creation_input_tokens: 5000,
      cache_read_input_tokens: 200000,
      output_tokens: 300,
    };
    const line = (text: string) => ({
      type: "assistant",
      message: {
        id: "msg_A",
        role: "assistant",
        content: [{ type: "text", text }],
        usage: sameUsage,
      },
    });
    const usage = usageFromRecords([line("a"), line("b"), line("c")]);
    // fused input = 10 + 5000 + 200000 = 205010 (counted ONCE, not 615030)
    expect(usage?.totalInputTokens).toBe(205010);
    expect(usage?.totalCacheReadInputTokens).toBe(200000);
    expect(usage?.totalCacheCreationInputTokens).toBe(5000);
    expect(usage?.totalOutputTokens).toBe(300);
  });

  it("takes max output_tokens across streaming lines of one message.id", () => {
    // Streaming writes the same message.id with a growing output_tokens.
    const streamed = (output: number) => ({
      type: "assistant",
      message: {
        id: "msg_B",
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        usage: {
          input_tokens: 7,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 50000,
          output_tokens: output,
        },
      },
    });
    const usage = usageFromRecords([streamed(1), streamed(120), streamed(503)]);
    expect(usage?.totalInputTokens).toBe(50007); // 7 + 50000, once
    expect(usage?.totalOutputTokens).toBe(503); // max, not 1 and not 624
  });

  it("still sums DISTINCT message.ids", () => {
    const turn = (id: string, cacheRead: number, output: number) => ({
      type: "assistant",
      message: {
        id,
        role: "assistant",
        content: [{ type: "text", text: id }],
        usage: {
          input_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: cacheRead,
          output_tokens: output,
        },
      },
    });
    // msg_1 repeated 2x (dedupe to once) + msg_2 once.
    const usage = usageFromRecords([
      turn("msg_1", 10000, 100),
      turn("msg_1", 10000, 100),
      turn("msg_2", 20000, 200),
    ]);
    // input: (5+10000) + (5+20000) = 30010 ; cache_read: 30000 ; output: 300
    expect(usage?.totalInputTokens).toBe(30010);
    expect(usage?.totalCacheReadInputTokens).toBe(30000);
    expect(usage?.totalOutputTokens).toBe(300);
  });
});
