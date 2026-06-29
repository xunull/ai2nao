import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";
import { upsertClaudeTokenUsageRow } from "../src/claudeTokenUsage/queries.js";
import type { ClaudeTokenUsageRow } from "../src/claudeTokenUsage/types.js";

function tokenRow(over: Partial<ClaudeTokenUsageRow>): ClaudeTokenUsageRow {
  return {
    session_id: "sid",
    project_id: "proj",
    file_path: "/x.jsonl",
    file_mtime_ms: 0,
    file_size_bytes: 0,
    cwd: "/tmp",
    project_key: "proj",
    project_path: "/tmp",
    identity_confidence: "high",
    title: null,
    created_at: null,
    last_updated_at: "2026-01-01T00:00:00.000Z",
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    model: null,
    token_status: "full",
    parse_error: null,
    missing_since: null,
    source_seen_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    preview: null,
    message_count: null,
    ...over,
  };
}

describe("Claude project list — recency sort", () => {
  it("orders projects by last-active (DB time beats alpha and stale mtime; null sinks)", async () => {
    const base = join(tmpdir(), `ai2nao-cc-projects-${Date.now()}`);
    const root = join(base, "projects");

    // Project "zzz-db": alphabetically LAST, file mtime is OLD (2023), but the
    // token DB carries a future last_updated_at (2027) with a matching size.
    // Must sort FIRST — proving recency beats alpha AND DB beats stale mtime.
    const zzzDir = join(root, "zzz-db");
    mkdirSync(zzzDir, { recursive: true });
    const zzzFile = join(zzzDir, "s1.jsonl");
    writeFileSync(zzzFile, "{}\n", "utf8");
    utimesSync(zzzFile, new Date("2023-01-01"), new Date("2023-01-01"));

    // Project "aaa-mtime": alphabetically FIRST, mtime 2025, no DB row -> mtime fallback.
    const aaaDir = join(root, "aaa-mtime");
    mkdirSync(aaaDir, { recursive: true });
    const aaaFile = join(aaaDir, "s2.jsonl");
    writeFileSync(aaaFile, "{}\n", "utf8");
    utimesSync(aaaFile, new Date("2025-06-15"), new Date("2025-06-15"));

    // Project "mmm-empty": no session file -> lastActiveAt null -> sinks last.
    mkdirSync(join(root, "mmm-empty"), { recursive: true });

    const db = openDatabase(join(base, "idx.db"));
    try {
      upsertClaudeTokenUsageRow(
        db,
        tokenRow({
          session_id: "zzz-db:s1",
          project_id: "zzz-db",
          file_path: zzzFile,
          file_mtime_ms: Math.trunc(statSync(zzzFile).mtimeMs),
          file_size_bytes: statSync(zzzFile).size, // matches disk -> DB time trusted
          last_updated_at: "2027-01-01T00:00:00.000Z",
        })
      );

      const app = createApp({ db });
      const res = await app.request(
        `http://x/api/claude-code-history/projects?projectsRoot=${encodeURIComponent(root)}`
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        projects: { id: string; lastActiveAt: string | null }[];
      };

      expect(json.projects.map((p) => p.id)).toEqual([
        "zzz-db", // 2027 via DB — first despite alpha-last + old mtime
        "aaa-mtime", // 2025 via mtime fallback
        "mmm-empty", // null — sinks
      ]);
      expect(json.projects[0].lastActiveAt).toBe("2027-01-01T00:00:00.000Z");
      expect(json.projects[2].lastActiveAt).toBeNull();
    } finally {
      db.close();
    }
  });
});
