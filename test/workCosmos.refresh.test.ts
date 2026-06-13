import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { refreshCosmos } from "../src/workCosmos/refresh.js";
import {
  getCosmosState,
  listCosmosVectorsForProjection,
} from "../src/workCosmos/queries.js";
import {
  blobToFloat32,
  type EmbeddingResult,
} from "../src/rag/embeddings.js";

function fakeEmbedder(dim = 8): (texts: string[]) => Promise<EmbeddingResult[]> {
  return async (texts) =>
    texts.map((text, i) => {
      const v = new Float32Array(dim);
      for (let j = 0; j < dim; j++) {
        v[j] = (text.charCodeAt(j % text.length) / 100 + i) * 0.01;
      }
      return { dim, vector: v };
    });
}

function seedClaudeSession(
  db: Database.Database,
  args: {
    session_id: string;
    file_path: string;
    project_key?: string;
    project_path?: string;
    total_tokens?: number;
    token_status?: "full" | "unknown" | "error";
  }
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO claude_session_token_usage
       (session_id, project_id, file_path, file_mtime_ms, file_size_bytes,
        cwd, project_key, project_path, identity_confidence,
        title, created_at, last_updated_at,
        input_tokens, output_tokens, total_tokens,
        token_status, parse_error, missing_since, source_seen_at, updated_at)
     VALUES (@session_id, 'p1', @file_path, 0, 0, '/tmp', @project_key, @project_path, 'high',
             'title', @created_at, @last_updated_at, 100, 50, @total_tokens,
             @token_status, NULL, NULL, @now, @now)`
  ).run({
    session_id: args.session_id,
    file_path: args.file_path,
    project_key: args.project_key ?? "/tmp/test",
    project_path: args.project_path ?? "/tmp/test",
    created_at: now,
    last_updated_at: now,
    total_tokens: args.total_tokens ?? 150,
    token_status: args.token_status ?? "full",
    now,
  });
}

function writeJsonl(
  dir: string,
  basename: string,
  records: object[]
): string {
  const file = join(dir, basename);
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n"));
  return file;
}

function userAssistantPair(
  userText: string,
  assistantText: string
): object[] {
  return [
    {
      type: "user",
      sessionId: "s1",
      cwd: "/tmp",
      uuid: "u1",
      message: { role: "user", content: userText },
    },
    {
      type: "assistant",
      sessionId: "s1",
      cwd: "/tmp",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: assistantText }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ];
}

describe("refreshCosmos", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "ai2nao-cosmos-refresh-"));
    dataDir = join(base, "jsonl");
    mkdirSync(dataDir, { recursive: true });
    db = openDatabase(join(base, "test.db"));
  });

  it("happy path: embeds substantive sessions, skips empty ones", async () => {
    const file1 = writeJsonl(
      dataDir,
      "s1.jsonl",
      userAssistantPair(
        "How do prompt-cache fields work in Claude?",
        "input_tokens is just fresh bytes; cache_creation and cache_read also count."
      )
    );
    seedClaudeSession(db, {
      session_id: "p:s1",
      file_path: file1,
    });

    const result = await refreshCosmos(db, { embedder: fakeEmbedder(8) });

    expect(result.status).toBe("success");
    expect(result.sourceSessionCount).toBe(1);
    expect(result.embeddedSessionCount).toBe(1);
    expect(result.noSummarySessionCount).toBe(0);
    expect(result.errorSessionCount).toBe(0);

    const vectors = listCosmosVectorsForProjection(db);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]!.embedding_dim).toBe(8);
    expect(blobToFloat32(vectors[0]!.vector).length).toBe(8);
  });

  it("marks pure-boilerplate session as no_summary, no embedding row", async () => {
    const file1 = writeJsonl(
      dataDir,
      "s1.jsonl",
      userAssistantPair(
        "<command-message>git status</command-message>",
        ""
      )
    );
    seedClaudeSession(db, { session_id: "p:s1", file_path: file1 });

    const result = await refreshCosmos(db, { embedder: fakeEmbedder() });

    expect(result.noSummarySessionCount).toBe(1);
    expect(result.embeddedSessionCount).toBe(0);
    const vectors = listCosmosVectorsForProjection(db);
    expect(vectors).toHaveLength(0);

    const point = db
      .prepare(
        "SELECT embedding_status FROM work_cosmos_points WHERE session_id = ?"
      )
      .get("p:s1") as { embedding_status: string };
    expect(point.embedding_status).toBe("no_summary");
  });

  it("(mtime,size) skip path leaves embedding untouched on second run", async () => {
    const file1 = writeJsonl(
      dataDir,
      "s1.jsonl",
      userAssistantPair(
        "Design the cosmos page layout for /dashboard/cosmos",
        "Recharts ScatterChart, color=source, size=tokens, PNG export button."
      )
    );
    seedClaudeSession(db, { session_id: "p:s1", file_path: file1 });

    // Freeze mtime so second run sees identical (mtime, size)
    const frozen = new Date("2026-06-13T00:00:00Z");
    utimesSync(file1, frozen, frozen);

    let calls = 0;
    const countingEmbedder = async (texts: string[]) => {
      calls++;
      return fakeEmbedder(8)(texts);
    };
    await refreshCosmos(db, { embedder: countingEmbedder });
    expect(calls).toBe(1);

    const second = await refreshCosmos(db, { embedder: countingEmbedder });
    expect(calls).toBe(1); // skipped, no embed call
    expect(second.skippedUnchangedCount).toBe(1);
    expect(second.embeddedSessionCount).toBe(0);
  });

  it("force full re-embeds even when (mtime,size) unchanged", async () => {
    const file1 = writeJsonl(
      dataDir,
      "s1.jsonl",
      userAssistantPair(
        "Trigger rule_version self-heal here",
        "Self-heal pattern: bump RULE_VERSION + force full at entry."
      )
    );
    seedClaudeSession(db, { session_id: "p:s1", file_path: file1 });
    const frozen = new Date("2026-06-13T00:00:00Z");
    utimesSync(file1, frozen, frozen);

    let calls = 0;
    const countingEmbedder = async (texts: string[]) => {
      calls++;
      return fakeEmbedder(8)(texts);
    };
    await refreshCosmos(db, { embedder: countingEmbedder });
    await refreshCosmos(db, { embedder: countingEmbedder, full: true });
    expect(calls).toBe(2);
  });

  it("auto-forces full when state.rule_version is stale (self-heal)", async () => {
    const file1 = writeJsonl(
      dataDir,
      "s1.jsonl",
      userAssistantPair(
        "test session for self-heal",
        "vector should be re-embedded because rule_version doesn't match"
      )
    );
    seedClaudeSession(db, { session_id: "p:s1", file_path: file1 });
    const frozen = new Date("2026-06-13T00:00:00Z");
    utimesSync(file1, frozen, frozen);

    let calls = 0;
    const countingEmbedder = async (texts: string[]) => {
      calls++;
      return fakeEmbedder(8)(texts);
    };
    await refreshCosmos(db, { embedder: countingEmbedder });
    expect(calls).toBe(1);

    // Downgrade stored rule_version to simulate older parser
    db.prepare(
      "UPDATE work_cosmos_state SET rule_version = 0 WHERE id = 1"
    ).run();

    await refreshCosmos(db, { embedder: countingEmbedder });
    expect(calls).toBe(2); // self-heal forced re-embed
    expect(getCosmosState(db)?.rule_version).toBe(1);
  });

  it("on embedder 429: marks all pending as rate_limited", async () => {
    const file1 = writeJsonl(
      dataDir,
      "s1.jsonl",
      userAssistantPair(
        "Substantive user question about cosmos",
        "Substantive assistant reply explaining the answer."
      )
    );
    seedClaudeSession(db, { session_id: "p:s1", file_path: file1 });

    const result = await refreshCosmos(db, {
      embedder: async () => {
        throw new Error("embeddings HTTP 429: rate limited");
      },
    });

    expect(result.errorSessionCount).toBe(1);
    expect(result.status).not.toBe("success");
    const point = db
      .prepare(
        "SELECT embedding_status FROM work_cosmos_points WHERE session_id = ?"
      )
      .get("p:s1") as { embedding_status: string };
    expect(point.embedding_status).toBe("rate_limited");
  });

  it("on embedder 401: marks all pending as auth_failed", async () => {
    const file1 = writeJsonl(
      dataDir,
      "s1.jsonl",
      userAssistantPair(
        "Substantive question goes here",
        "Substantive response goes here as well."
      )
    );
    seedClaudeSession(db, { session_id: "p:s1", file_path: file1 });

    await refreshCosmos(db, {
      embedder: async () => {
        throw new Error("embeddings HTTP 401: unauthorized");
      },
    });

    const point = db
      .prepare(
        "SELECT embedding_status FROM work_cosmos_points WHERE session_id = ?"
      )
      .get("p:s1") as { embedding_status: string };
    expect(point.embedding_status).toBe("auth_failed");
  });

  it("missing source file → mark session as missing on next run", async () => {
    const file1 = writeJsonl(
      dataDir,
      "s1.jsonl",
      userAssistantPair(
        "First session that will later disappear",
        "Reply for that session before it disappears."
      )
    );
    const file2 = writeJsonl(
      dataDir,
      "s2.jsonl",
      userAssistantPair(
        "Second session that stays",
        "Reply for second session that survives."
      )
    );
    seedClaudeSession(db, { session_id: "p:s1", file_path: file1 });
    seedClaudeSession(db, { session_id: "p:s2", file_path: file2 });

    await refreshCosmos(db, { embedder: fakeEmbedder() });
    expect(listCosmosVectorsForProjection(db)).toHaveLength(2);

    // simulate source disappearing — mark s1 missing in upstream table
    db.prepare(
      "UPDATE claude_session_token_usage SET missing_since = ? WHERE session_id = ?"
    ).run(new Date().toISOString(), "p:s1");

    const second = await refreshCosmos(db, { embedder: fakeEmbedder() });
    expect(second.missingMarkedCount).toBe(1);

    const s1 = db
      .prepare(
        "SELECT missing_since FROM work_cosmos_points WHERE session_id = 'p:s1'"
      )
      .get() as { missing_since: string | null };
    expect(s1.missing_since).not.toBeNull();
    // s2 still active and embedded
    expect(listCosmosVectorsForProjection(db)).toHaveLength(1);
  });

  it("writes state row that reflects this run's counts", async () => {
    const file1 = writeJsonl(
      dataDir,
      "s1.jsonl",
      userAssistantPair(
        "Real user question with enough length to count",
        "Real assistant answer with enough length to count."
      )
    );
    seedClaudeSession(db, { session_id: "p:s1", file_path: file1 });

    await refreshCosmos(db, { embedder: fakeEmbedder() });

    const state = getCosmosState(db)!;
    expect(state.rule_version).toBe(1);
    expect(state.source_session_count).toBe(1);
    expect(state.indexed_session_count).toBe(1);
    expect(state.embedded_session_count).toBe(1);
    expect(state.no_summary_session_count).toBe(0);
    expect(state.error_session_count).toBe(0);
    expect(state.skipped_unchanged_count).toBe(0);
    expect(state.last_error).toBeNull();
  });
});
