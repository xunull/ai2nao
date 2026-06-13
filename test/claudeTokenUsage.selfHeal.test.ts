import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { refreshClaudeTokenUsage } from "../src/claudeTokenUsage/refresh.js";
import {
  getClaudeTokenUsageState,
  upsertClaudeTokenUsageRow,
  upsertClaudeTokenUsageState,
} from "../src/claudeTokenUsage/queries.js";
import {
  CLAUDE_TOKEN_USAGE_RULE_VERSION,
  type ClaudeTokenUsageRow,
} from "../src/claudeTokenUsage/types.js";

function readAllRows(db: Database.Database): ClaudeTokenUsageRow[] {
  return db
    .prepare("SELECT * FROM claude_session_token_usage WHERE missing_since IS NULL")
    .all() as ClaudeTokenUsageRow[];
}

/**
 * Regression: after bumping CLAUDE_TOKEN_USAGE_RULE_VERSION (e.g. v1 → v2
 * to add prompt-cache fields), the next refresh tick must auto-force full
 * reparse so historical rows written by the older parser get rewritten.
 * Otherwise the incremental skip path (mtime+size match) leaves old values
 * sitting in the DB forever.
 */
describe("refreshClaudeTokenUsage self-heal on rule_version bump", () => {
  let projectsRoot: string;
  let db: Database.Database;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "ai2nao-claude-heal-"));
    projectsRoot = join(base, "projects");
    mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(join(base, "test.db"));
  });

  function writeSessionJsonl(
    projectId: string,
    sessionId: string,
    usage: Record<string, number>
  ): void {
    const projectDir = join(projectsRoot, projectId);
    mkdirSync(projectDir, { recursive: true });
    const filePath = join(projectDir, `${sessionId}.jsonl`);
    const line = {
      type: "assistant",
      sessionId,
      cwd: "/tmp/test",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage,
      },
    };
    writeFileSync(filePath, JSON.stringify(line) + "\n");
  }

  it("auto-forces full=true when stored state.rule_version is stale", async () => {
    // Cache-heavy assistant turn: 6 (fresh input) + 47655 (cache write) +
    // 22924 (cache read) + 252 (output). v1 reports only 258; v2 reports 70837.
    writeSessionJsonl("p1", "s1", {
      input_tokens: 6,
      cache_creation_input_tokens: 47655,
      cache_read_input_tokens: 22924,
      output_tokens: 252,
    });

    // 1) Run a normal refresh to populate the row naturally — gives us the
    //    real session_id format and matching mtime/size in the DB.
    await refreshClaudeTokenUsage(db, { projectsRoot });

    // The fresh run should already produce the v2 total (70837) — sanity.
    const rowsAfterInitial = readAllRows(db);
    expect(rowsAfterInitial).toHaveLength(1);
    expect(rowsAfterInitial[0]!.total_tokens).toBe(70837);

    // 2) Simulate "old DB": rewrite that row's tokens to the v1 value
    //    (input + output only, no cache) and downgrade state to v1.
    const stale = { ...rowsAfterInitial[0]!, total_tokens: 258, input_tokens: 6 };
    upsertClaudeTokenUsageRow(db, stale);
    const state = getClaudeTokenUsageState(db);
    expect(state).not.toBeNull();
    upsertClaudeTokenUsageState(db, { ...state!, rule_version: 1 });

    // 3) Caller asks for incremental (default). Self-heal should auto-flip
    //    to full and recompute the row to the v2 value.
    await refreshClaudeTokenUsage(db, { projectsRoot });

    const rowsAfterHeal = readAllRows(db);
    expect(rowsAfterHeal[0]!.total_tokens).toBe(70837);

    // 4) State must now record the new rule_version so subsequent ticks
    //    return to incremental mode.
    expect(getClaudeTokenUsageState(db)?.rule_version).toBe(
      CLAUDE_TOKEN_USAGE_RULE_VERSION
    );
  });

  it("does NOT force full when state.rule_version is current", async () => {
    writeSessionJsonl("p1", "s1", {
      input_tokens: 100,
      output_tokens: 50,
    });

    // First refresh seeds the row + writes state at current rule_version.
    await refreshClaudeTokenUsage(db, { projectsRoot });
    expect(getClaudeTokenUsageState(db)?.rule_version).toBe(
      CLAUDE_TOKEN_USAGE_RULE_VERSION
    );

    // Second refresh with no source changes: mtime + size still match AND
    // rule_version is current → row gets skipped.
    const result = await refreshClaudeTokenUsage(db, { projectsRoot });
    expect(result.skippedUnchangedCount).toBe(1);
  });
});
