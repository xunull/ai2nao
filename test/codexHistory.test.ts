import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  listCodexSessionSummaries,
  loadCodexSessionDetail,
} from "../src/codexHistory/index.js";
import { extractCodexSessionUsage } from "../src/codexHistory/normalize.js";
import { parseJsonlText } from "../src/localJsonl/parse.js";

const transcript = [
  JSON.stringify({ type: "session_meta", timestamp: "2026-04-26T00:00:00.000Z", payload: { cwd: "/work/app" } }),
  JSON.stringify({ type: "event_msg", timestamp: "2026-04-26T00:00:01.000Z", payload: { type: "user_message", message: "add codex history" } }),
  JSON.stringify({ type: "event_msg", timestamp: "2026-04-26T00:00:02.000Z", payload: { type: "agent_message", message: "working on it" } }),
  JSON.stringify({ type: "event_msg", timestamp: "2026-04-26T00:00:02.500Z", payload: { type: "token_count", input_tokens: 11, output_tokens: 7 } }),
  JSON.stringify({ type: "response_item", timestamp: "2026-04-26T00:00:03.000Z", payload: { type: "function_call", name: "read_file", call_id: "c1", arguments: JSON.stringify({ path: "/work/app/src/a.ts" }) } }),
  JSON.stringify({ type: "response_item", timestamp: "2026-04-26T00:00:04.000Z", payload: { type: "function_call_output", call_id: "c1", output: "secret output is not rendered here" } }),
  JSON.stringify({ type: "event_msg", timestamp: "2026-04-26T00:00:05.000Z", payload: { type: "exec_command_end", command: "npm test", cwd: "/work/app", exit_code: 1, status: "exited" } }),
].join("\n");

function makeRoot() {
  const root = join(tmpdir(), `ai2nao-codex-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessions = join(root, "sessions", "2026", "04", "26");
  mkdirSync(sessions, { recursive: true });
  return { root, sessions };
}

function createStateDb(root: string, rows: { id: string; rolloutPath: string; archived?: number }[]) {
  const dbPath = join(root, "state_5.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      git_branch TEXT,
      first_user_message TEXT NOT NULL DEFAULT '',
      model TEXT,
      created_at_ms INTEGER,
      updated_at_ms INTEGER
    );
  `);
  const stmt = db.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd,
      title, sandbox_policy, approval_mode, archived, git_branch,
      first_user_message, model, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 1, 2, 'codex', 'openai', '/work/app', ?, 'workspace-write',
      'on-request', ?, 'main', 'add codex history', 'gpt-5', ?, ?)
  `);
  for (const row of rows) {
    stmt.run(
      row.id,
      row.rolloutPath,
      row.id,
      row.archived ?? 0,
      Date.parse("2026-04-26T00:00:00.000Z"),
      Date.parse("2026-04-26T00:00:05.000Z")
    );
  }
  db.close();
}

describe("codexHistory", () => {
  it("lists SQLite threads, hides archived by default, and marks stale transcripts degraded", async () => {
    const { root, sessions } = makeRoot();
    const goodPath = join(sessions, "rollout-2026-04-26T00-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl");
    writeFileSync(goodPath, transcript, "utf8");
    createStateDb(root, [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", rolloutPath: goodPath },
      { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", rolloutPath: join(sessions, "missing.jsonl") },
      { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", rolloutPath: goodPath, archived: 1 },
    ]);

    const visible = await listCodexSessionSummaries(root, { archived: false });
    expect(visible.source).toBe("sqlite");
    expect(visible.sessions.map((s) => s.id).sort()).toEqual([
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    ]);
    const stale = visible.sessions.find((s) => s.id.startsWith("bbbb"));
    expect(stale?.metadata?.codex).toMatchObject({
      degraded: true,
      degradationReason: "transcript-missing",
    });

    const archived = await listCodexSessionSummaries(root, { archived: true });
    expect(archived.sessions.map((s) => s.id)).toEqual([
      "cccccccc-cccc-cccc-cccc-cccccccccccc",
    ]);
  });

  it("loads detail metrics and compact tool events from transcript JSONL", async () => {
    const { root, sessions } = makeRoot();
    const id = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const goodPath = join(sessions, `rollout-2026-04-26T00-00-00-${id}.jsonl`);
    writeFileSync(goodPath, transcript, "utf8");
    createStateDb(root, [{ id, rolloutPath: goodPath }]);

    const detail = await loadCodexSessionDetail(root, id);
    expect(detail?.metrics).toMatchObject({
      toolCallCount: 2,
      commandCount: 1,
      failedCommandCount: 1,
      fileCount: 1,
    });
    expect(detail?.session.usage).toEqual({ totalInputTokens: 11, totalOutputTokens: 7, totalReasoningOutputTokens: 0, totalCachedInputTokens: 0 });
    expect(detail?.session.source).toBe("codex");
    expect(detail?.session.messages.some((m) => m.metadata?.codexFailed)).toBe(true);
    expect(detail?.session.messages.some((m) => m.content.includes("secret output"))).toBe(false);
  });

  it("keeps token-only usage extraction in parity with detail normalization", async () => {
    const { root, sessions } = makeRoot();
    const id = "12121212-1212-1212-1212-121212121212";
    const goodPath = join(sessions, `rollout-2026-04-26T00-00-00-${id}.jsonl`);
    writeFileSync(goodPath, transcript, "utf8");
    createStateDb(root, [{ id, rolloutPath: goodPath }]);

    const detail = await loadCodexSessionDetail(root, id);
    const parsed = parseJsonlText(transcript);
    expect(extractCodexSessionUsage(parsed)).toEqual(detail?.session.usage);
  });

  it("does not estimate usage from unrecognized token_count payloads", async () => {
    const { root, sessions } = makeRoot();
    const id = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const goodPath = join(sessions, `rollout-2026-04-26T00-00-00-${id}.jsonl`);
    writeFileSync(
      goodPath,
      [
        JSON.stringify({ type: "session_meta", timestamp: "2026-04-26T00:00:00.000Z", payload: { cwd: "/work/app" } }),
        JSON.stringify({ type: "event_msg", timestamp: "2026-04-26T00:00:01.000Z", payload: { type: "user_message", message: "hello" } }),
        JSON.stringify({ type: "event_msg", timestamp: "2026-04-26T00:00:02.000Z", payload: { type: "token_count", total: 123 } }),
      ].join("\n"),
      "utf8"
    );
    createStateDb(root, [{ id, rolloutPath: goodPath }]);

    const detail = await loadCodexSessionDetail(root, id);
    expect(detail?.session.usage).toBeUndefined();
  });

  it("does NOT double-count reasoning into output (reasoning ⊆ output_tokens)", async () => {
    // Realistic Codex shape: reasoning_output_tokens is a SUBSET of
    // output_tokens, so total_tokens == input + output (NOT + reasoning).
    // Verified against real rollouts (23202/23202). Regression: old code did
    // output + reasoning, inflating Codex output by ~22.6%.
    const { root, sessions } = makeRoot();
    const id = "99999999-9999-9999-9999-999999999999";
    const goodPath = join(sessions, `rollout-2026-04-26T00-00-00-${id}.jsonl`);
    writeFileSync(
      goodPath,
      [
        JSON.stringify({ type: "session_meta", timestamp: "2026-04-26T00:00:00.000Z", payload: { cwd: "/work/app" } }),
        JSON.stringify({ type: "event_msg", timestamp: "2026-04-26T00:00:01.000Z", payload: { type: "user_message", message: "hello" } }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-04-26T00:00:02.000Z",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 30, // already includes the 7 reasoning tokens
                reasoning_output_tokens: 7,
                total_tokens: 130, // == input(100) + output(30), reasoning NOT added
              },
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 30,
                reasoning_output_tokens: 7,
                total_tokens: 130,
              },
            },
          },
        }),
      ].join("\n"),
      "utf8"
    );
    createStateDb(root, [{ id, rolloutPath: goodPath }]);

    const detail = await loadCodexSessionDetail(root, id);
    // output is 30, NOT 37 — reasoning is already inside output;
    // reasoning is tracked separately (7) for the "Codex 输出构成" display
    expect(detail?.session.usage).toEqual({
      totalInputTokens: 100,
      totalOutputTokens: 30,
      totalReasoningOutputTokens: 7,
      totalCachedInputTokens: 20,
    });
  });

  it("diffs cumulative Codex info.total_token_usage instead of double-counting totals", async () => {
    const { root, sessions } = makeRoot();
    const id = "88888888-8888-8888-8888-888888888888";
    const goodPath = join(sessions, `rollout-2026-04-26T00-00-00-${id}.jsonl`);
    writeFileSync(
      goodPath,
      [
        JSON.stringify({ type: "session_meta", timestamp: "2026-04-26T00:00:00.000Z", payload: { cwd: "/work/app" } }),
        JSON.stringify({ type: "event_msg", timestamp: "2026-04-26T00:00:01.000Z", payload: { type: "user_message", message: "hello" } }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-04-26T00:00:02.000Z",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10,
                output_tokens: 3, // includes its 2 reasoning tokens
                reasoning_output_tokens: 2,
                cached_input_tokens: 6, // subset of input
              },
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-04-26T00:00:03.000Z",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 25,
                output_tokens: 8, // includes its 4 reasoning tokens
                reasoning_output_tokens: 4,
                cached_input_tokens: 15, // subset of input
              },
            },
          },
        }),
      ].join("\n"),
      "utf8"
    );
    createStateDb(root, [{ id, rolloutPath: goodPath }]);

    const detail = await loadCodexSessionDetail(root, id);
    // cumulative total → diffed; output is 8 (NOT 12 — reasoning not double-counted).
    // reasoning: first total (prev=undefined) contributes its full 2, second
    // contributes delta 4-2=2 → total 4. cached mirrors: 6 + (15-6) = 15.
    expect(detail?.session.usage).toEqual({
      totalInputTokens: 25,
      totalOutputTokens: 8,
      totalReasoningOutputTokens: 4,
      totalCachedInputTokens: 15,
    });
  });

  it("falls back to bounded JSONL scan when SQLite is unavailable", async () => {
    const { root, sessions } = makeRoot();
    const id = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    writeFileSync(
      join(sessions, `rollout-2026-04-26T00-00-00-${id}.jsonl`),
      transcript,
      "utf8"
    );

    const result = await listCodexSessionSummaries(root, {
      archived: false,
      maxFiles: 1,
    });
    expect(result.source).toBe("fallback");
    expect(result.diagnostics[0].kind).toBe("state-db-unavailable");
    expect(result.sessions[0].id).toBe(id);
  });
});
