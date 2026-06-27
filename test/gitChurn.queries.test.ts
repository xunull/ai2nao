import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { buildProjectOutput } from "../src/gitChurn/queries.js";
import { localDay } from "../src/gitChurn/collect.js";

const REPO = "/r/app";
let base: string;
let db: Database.Database;

function seedRepo(path = REPO) {
  db.prepare(
    "INSERT INTO repos (path_canonical, first_seen_at) VALUES (?, ?)"
  ).run(path, "2026-01-01T00:00:00Z");
  db.prepare(
    "INSERT INTO git_line_churn_state (repo_path, last_synced_sha, rule_version, updated_at) VALUES (?, 'abc', 1, ?)"
  ).run(path, "2026-06-26T00:00:00Z");
}

function seedChurn(projectKey: string, day: string, added: number, deleted: number, commits: number) {
  db.prepare(
    "INSERT INTO git_line_churn (project_key, day, added, deleted, commits) VALUES (?, ?, ?, ?, ?)"
  ).run(projectKey, day, added, deleted, commits);
}

function seedClaude(sessionId: string, projectKey: string, lastUpdatedAt: string, total: number) {
  db.prepare(
    `INSERT INTO claude_session_token_usage
       (session_id, project_id, file_path, file_mtime_ms, file_size_bytes, cwd,
        project_key, project_path, identity_confidence, last_updated_at,
        input_tokens, output_tokens, total_tokens, token_status, missing_since,
        source_seen_at, updated_at)
     VALUES (?, 'p', '/f', 0, 0, ?, ?, ?, 'high', ?, 0, 0, ?, 'full', NULL, ?, ?)`
  ).run(sessionId, projectKey, projectKey, projectKey, lastUpdatedAt, total, lastUpdatedAt, lastUpdatedAt);
}

function seedCodexSession(sessionId: string, projectKey: string) {
  db.prepare(
    `INSERT INTO codex_session_token_usage
       (session_id, rollout_path, rollout_mtime_ms, rollout_size_bytes, cwd,
        project_key, project_path, identity_confidence, last_updated_at,
        input_tokens, output_tokens, total_tokens, token_status, missing_since,
        source_seen_at, updated_at)
     VALUES (?, '/r', 0, 0, ?, ?, ?, 'high', '2026-06-20T00:00:00Z', 0, 0, 0, 'full', NULL,
        '2026-06-20T00:00:00Z', '2026-06-20T00:00:00Z')`
  ).run(sessionId, projectKey, projectKey, projectKey);
}

function seedCodexEvent(sessionId: string, eventAt: string, input: number, output: number) {
  db.prepare(
    "INSERT INTO codex_token_usage_event (session_id, event_at, input_tokens, output_tokens, reasoning_output_tokens) VALUES (?, ?, ?, ?, 0)"
  ).run(sessionId, eventAt, input, output);
}

const WINDOW = { from: new Date("2026-06-15T00:00:00Z"), to: new Date("2026-06-28T00:00:00Z") };
const inDay = localDay(new Date("2026-06-20T12:00:00Z"));

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ai2nao-churnq-"));
  db = openDatabase(join(base, "idx.db"));
});
afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe("buildProjectOutput", () => {
  it("joins Claude tokens (per-session) + Codex tokens (event table) to repo churn", () => {
    seedRepo();
    seedChurn(REPO, inDay, 100, 10, 4);
    seedClaude("c1", REPO, "2026-06-20T00:00:00Z", 600);
    seedCodexSession("x1", REPO);
    seedCodexEvent("x1", "2026-06-20T01:00:00Z", 300, 100); // 400 tokens in window

    const res = buildProjectOutput(db, WINDOW);
    const row = res.rows.find((r) => r.repo === REPO)!;
    expect(row.tokens).toBe(1000); // 600 claude + 400 codex
    expect(row.added).toBe(100);
    expect(row.tokensPerLine).toBe(10); // 1000 / 100
    expect(row.status).toBe("ok");
  });

  it("excludes Codex events outside the window (avoids multi-day collapse)", () => {
    seedRepo();
    seedChurn(REPO, inDay, 50, 0, 1);
    seedCodexSession("x1", REPO);
    seedCodexEvent("x1", "2026-06-20T01:00:00Z", 100, 100); // in window -> 200
    seedCodexEvent("x1", "2026-01-01T00:00:00Z", 999, 999); // out of window -> excluded

    const row = buildProjectOutput(db, WINDOW).rows.find((r) => r.repo === REPO)!;
    expect(row.tokens).toBe(200); // only the in-window event
  });

  it("aggregates a subdir Claude project up to the repo (repo-level output)", () => {
    seedRepo();
    seedChurn(REPO, inDay, 40, 0, 2);
    seedClaude("c1", REPO, "2026-06-20T00:00:00Z", 500);
    seedClaude("c2", `${REPO}/packages/web`, "2026-06-21T00:00:00Z", 300); // subdir

    const rows = buildProjectOutput(db, WINDOW).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe(REPO);
    expect(rows[0].tokens).toBe(800); // 500 + 300 aggregated up
  });

  it("excludes Claude sessions outside the window", () => {
    seedRepo();
    seedChurn(REPO, inDay, 10, 0, 1);
    seedClaude("c1", REPO, "2026-06-20T00:00:00Z", 100); // in
    seedClaude("c2", REPO, "2026-01-01T00:00:00Z", 9999); // out

    expect(buildProjectOutput(db, WINDOW).rows[0].tokens).toBe(100);
  });
});
