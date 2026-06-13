/**
 * Cosmos refresh pipeline.
 *
 * Pulls source sessions from the existing token-usage tables (claude /
 * codex), checks `(file_path, mtime, size)` for incremental skip (D2),
 * summarizes new sessions, hands them to the existing RAG embedding
 * provider, writes vectors into the sidecar embeddings table, and stamps
 * a state row.
 *
 * Projection (UMAP → x,y) is a Day-2 step and lives in `project.ts`; this
 * refresh only fills `embedding_status='ok'` — the page only renders points
 * whose x/y are non-null AND embedding_status='ok'.
 *
 * Self-heal: same pattern as claudeTokenUsage. If state.rule_version
 * differs from COSMOS_RULE_VERSION, this run flips into full mode.
 */
import { readFile, stat } from "node:fs/promises";
import type Database from "better-sqlite3";
import { parseJsonlText } from "../localJsonl/parse.js";
import { buildClaudeSession } from "../claudeCodeHistory/normalize.js";
import { buildCodexSession } from "../codexHistory/normalize.js";
import {
  fetchEmbeddingsBatch,
  float32ToBlob,
  type EmbeddingResult,
} from "../rag/embeddings.js";
import { readRagConfig } from "../rag/config.js";
import {
  getCosmosState,
  isCosmosStateStale,
  listCosmosVectorsForProjection,
  markUnseenCosmosPointsMissing,
  upsertCosmosEmbedding,
  upsertCosmosPoint,
  upsertCosmosState,
} from "./queries.js";
import { summarizeSessionForCosmos } from "./summarize.js";
import {
  COSMOS_RULE_VERSION,
  type CosmosEmbeddingStatus,
  type CosmosPointRow,
  type CosmosRefreshResult,
  type CosmosSource,
  type CosmosTokenStatus,
} from "./types.js";

type SourceSession = {
  session_id: string;
  source: CosmosSource;
  source_path: string;
  project_key: string;
  project_path: string;
  total_tokens: number;
  token_status: CosmosTokenStatus;
};

type PendingEmbed = {
  session_id: string;
  summary: string;
};

export type RefreshCosmosOptions = {
  full?: boolean;
  /** Override embedding text per session — used by tests to skip parsing jsonl. */
  embedTextOverride?: Map<string, string>;
  /** Inject an embedder — tests pass a stub instead of hitting DashScope. */
  embedder?: (texts: string[]) => Promise<EmbeddingResult[]>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function ms(started: number): number {
  return Date.now() - started;
}

function listSourceSessions(db: Database.Database): SourceSession[] {
  const claude = db
    .prepare(
      `SELECT session_id, file_path, project_key, project_path,
              total_tokens, token_status
       FROM claude_session_token_usage
       WHERE missing_since IS NULL`
    )
    .all() as {
    session_id: string;
    file_path: string;
    project_key: string;
    project_path: string;
    total_tokens: number;
    token_status: CosmosTokenStatus;
  }[];
  const codex = db
    .prepare(
      `SELECT session_id, rollout_path, project_key, project_path,
              total_tokens, token_status
       FROM codex_session_token_usage
       WHERE missing_since IS NULL`
    )
    .all() as {
    session_id: string;
    rollout_path: string;
    project_key: string;
    project_path: string;
    total_tokens: number;
    token_status: CosmosTokenStatus;
  }[];
  return [
    ...claude.map<SourceSession>((r) => ({
      session_id: r.session_id,
      source: "claude",
      source_path: r.file_path,
      project_key: r.project_key,
      project_path: r.project_path,
      total_tokens: r.total_tokens,
      token_status: r.token_status,
    })),
    ...codex.map<SourceSession>((r) => ({
      session_id: r.session_id,
      source: "codex",
      source_path: r.rollout_path,
      project_key: r.project_key,
      project_path: r.project_path,
      total_tokens: r.total_tokens,
      token_status: r.token_status,
    })),
  ];
}

async function summarizeFromDisk(
  source: SourceSession,
  fileMtimeMs: number
): Promise<string | null> {
  const text = await readFile(source.source_path, "utf8");
  const parsed = parseJsonlText(text);
  const built =
    source.source === "claude"
      ? buildClaudeSession({
          projectId: source.session_id.split(":")[0] ?? source.session_id,
          sessionId: source.session_id.split(":")[1] ?? source.session_id,
          parse: parsed,
          fileMtimeMs,
        })
      : buildCodexSession({
          sessionId: source.session_id,
          parse: parsed,
          fileMtimeMs,
        });
  return summarizeSessionForCosmos(built.session.messages);
}

function getExistingMtimeSize(
  db: Database.Database,
  sessionId: string
): { mtime: number; size: number; status: CosmosEmbeddingStatus } | null {
  return (
    (db
      .prepare(
        `SELECT source_mtime_ms AS mtime, source_size_bytes AS size,
                embedding_status AS status
         FROM work_cosmos_points
         WHERE session_id = ?`
      )
      .get(sessionId) as
      | { mtime: number; size: number; status: CosmosEmbeddingStatus }
      | undefined) ?? null
  );
}

export async function refreshCosmos(
  db: Database.Database,
  options: RefreshCosmosOptions = {}
): Promise<CosmosRefreshResult> {
  const started = Date.now();
  const refreshedAt = nowIso();
  const seen = new Set<string>();
  const errors: string[] = [];

  // Self-heal: stored rule_version stale -> force full re-embed
  const ruleStale = isCosmosStateStale(db);
  const effectiveOptions = ruleStale ? { ...options, full: true } : options;

  const sources = listSourceSessions(db);

  let indexedSessionCount = 0;
  let noSummarySessionCount = 0;
  let errorSessionCount = 0;
  let skippedUnchangedCount = 0;

  const pending: PendingEmbed[] = [];

  for (const src of sources) {
    seen.add(src.session_id);
    let st: { mtimeMs: number; size: number };
    try {
      st = await stat(src.source_path);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${src.session_id}: stat failed: ${msg}`);
      // can't even stat — write row marked error
      upsertCosmosPoint(db, {
        session_id: src.session_id,
        source: src.source,
        source_path: src.source_path,
        source_mtime_ms: 0,
        source_size_bytes: 0,
        project_key: src.project_key,
        project_path: src.project_path,
        total_tokens: src.total_tokens,
        x: null,
        y: null,
        cluster_id: null,
        token_status: src.token_status,
        embedding_status: "provider_error",
        missing_since: null,
        source_seen_at: refreshedAt,
        updated_at: refreshedAt,
      });
      indexedSessionCount++;
      errorSessionCount++;
      continue;
    }

    const mtime = Math.trunc(st.mtimeMs);
    const size = st.size;

    const existing = getExistingMtimeSize(db, src.session_id);
    if (
      !effectiveOptions.full &&
      existing &&
      existing.mtime === mtime &&
      existing.size === size &&
      existing.status === "ok"
    ) {
      // skip — mark seen so we don't accidentally flag as missing
      db.prepare(
        `UPDATE work_cosmos_points
         SET source_seen_at = ?, missing_since = NULL
         WHERE session_id = ?`
      ).run(refreshedAt, src.session_id);
      skippedUnchangedCount++;
      indexedSessionCount++;
      continue;
    }

    // need fresh summary + embedding
    let summary: string | null;
    try {
      summary =
        options.embedTextOverride?.get(src.session_id) ??
        (await summarizeFromDisk(src, st.mtimeMs));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${src.session_id}: summarize failed: ${msg}`);
      upsertCosmosPoint(db, {
        session_id: src.session_id,
        source: src.source,
        source_path: src.source_path,
        source_mtime_ms: mtime,
        source_size_bytes: size,
        project_key: src.project_key,
        project_path: src.project_path,
        total_tokens: src.total_tokens,
        x: null,
        y: null,
        cluster_id: null,
        token_status: src.token_status,
        embedding_status: "provider_error",
        missing_since: null,
        source_seen_at: refreshedAt,
        updated_at: refreshedAt,
      });
      indexedSessionCount++;
      errorSessionCount++;
      continue;
    }

    const baseRow: CosmosPointRow = {
      session_id: src.session_id,
      source: src.source,
      source_path: src.source_path,
      source_mtime_ms: mtime,
      source_size_bytes: size,
      project_key: src.project_key,
      project_path: src.project_path,
      total_tokens: src.total_tokens,
      x: null,
      y: null,
      cluster_id: null,
      token_status: src.token_status,
      embedding_status: "pending",
      missing_since: null,
      source_seen_at: refreshedAt,
      updated_at: refreshedAt,
    };

    if (!summary) {
      upsertCosmosPoint(db, { ...baseRow, embedding_status: "no_summary" });
      indexedSessionCount++;
      noSummarySessionCount++;
      continue;
    }

    upsertCosmosPoint(db, baseRow);
    pending.push({ session_id: src.session_id, summary });
    indexedSessionCount++;
  }

  // Embed pending
  let embeddedSessionCount = 0;
  if (pending.length > 0) {
    const texts = pending.map((p) => p.summary);
    try {
      const embedder =
        options.embedder ??
        (async (ts: string[]) => {
          const cfg = readRagConfig();
          if (!cfg) throw new Error("rag.json not found");
          return fetchEmbeddingsBatch(ts, cfg);
        });
      const vectors = await embedder(texts);
      if (vectors.length !== pending.length) {
        throw new Error(
          `embedder returned ${vectors.length}, expected ${pending.length}`
        );
      }
      const writeTx = db.transaction(() => {
        for (let i = 0; i < pending.length; i++) {
          const { session_id, summary } = pending[i]!;
          const vec = vectors[i]!;
          upsertCosmosEmbedding(db, {
            session_id,
            embedding_dim: vec.dim,
            vector: float32ToBlob(vec.vector),
            summary,
            updated_at: refreshedAt,
          });
          db.prepare(
            `UPDATE work_cosmos_points
             SET embedding_status = 'ok', updated_at = ?
             WHERE session_id = ?`
          ).run(refreshedAt, session_id);
        }
      });
      writeTx();
      embeddedSessionCount = pending.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`embedding batch failed: ${msg}`);
      const status: CosmosEmbeddingStatus = /401|403|auth/i.test(msg)
        ? "auth_failed"
        : /429|rate/i.test(msg)
          ? "rate_limited"
          : "provider_error";
      const failTx = db.transaction(() => {
        for (const p of pending) {
          db.prepare(
            `UPDATE work_cosmos_points
             SET embedding_status = ?, updated_at = ?
             WHERE session_id = ?`
          ).run(status, refreshedAt, p.session_id);
        }
      });
      failTx();
      errorSessionCount += pending.length;
    }
  }

  const missingMarkedCount = markUnseenCosmosPointsMissing(
    db,
    seen,
    refreshedAt
  );

  const status: "success" | "partial" | "failed" =
    errors.length === 0
      ? "success"
      : embeddedSessionCount + skippedUnchangedCount > 0
        ? "partial"
        : "failed";

  const previous = getCosmosState(db);
  upsertCosmosState(db, {
    rule_version: COSMOS_RULE_VERSION,
    last_rebuilt_at: status === "failed" ? null : refreshedAt,
    last_error: errors[0] ?? null,
    source_session_count: sources.length,
    indexed_session_count: indexedSessionCount,
    embedded_session_count: embeddedSessionCount,
    no_summary_session_count: noSummarySessionCount,
    error_session_count: errorSessionCount,
    skipped_unchanged_count: skippedUnchangedCount,
    projection_method: previous?.projection_method ?? "none",
    projected_session_count: previous?.projected_session_count ?? 0,
    duration_ms: ms(started),
    updated_at: refreshedAt,
  });

  return {
    ok: status !== "failed",
    status,
    sourceSessionCount: sources.length,
    indexedSessionCount,
    embeddedSessionCount,
    noSummarySessionCount,
    errorSessionCount,
    skippedUnchangedCount,
    missingMarkedCount,
    projectionMethod: previous?.projection_method ?? "none",
    projectedSessionCount: previous?.projected_session_count ?? 0,
    durationMs: ms(started),
    errors,
  };
}

/** Convenience for callers that just need to read fresh vectors after refresh. */
export function listProjectionInputs(
  db: Database.Database
): { session_id: string; vector: Buffer; dim: number }[] {
  return listCosmosVectorsForProjection(db).map((r) => ({
    session_id: r.session_id,
    vector: r.vector,
    dim: r.embedding_dim,
  }));
}
