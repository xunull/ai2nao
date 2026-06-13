import type Database from "better-sqlite3";
import {
  COSMOS_RULE_VERSION,
  type CosmosEmbeddingRow,
  type CosmosEmbeddingStatus,
  type CosmosPointRow,
  type CosmosStateRow,
} from "./types.js";

export function getCosmosState(db: Database.Database): CosmosStateRow | null {
  return (
    (db
      .prepare(
        `SELECT id, rule_version, last_rebuilt_at, last_error,
                source_session_count, indexed_session_count,
                embedded_session_count, no_summary_session_count,
                error_session_count, skipped_unchanged_count,
                projection_method, projected_session_count,
                duration_ms, updated_at
         FROM work_cosmos_state
         WHERE id = 1`
      )
      .get() as CosmosStateRow | undefined) ?? null
  );
}

export function upsertCosmosState(
  db: Database.Database,
  state: Omit<CosmosStateRow, "id">
): void {
  db.prepare(
    `INSERT INTO work_cosmos_state
       (id, rule_version, last_rebuilt_at, last_error,
        source_session_count, indexed_session_count,
        embedded_session_count, no_summary_session_count,
        error_session_count, skipped_unchanged_count,
        projection_method, projected_session_count,
        duration_ms, updated_at)
     VALUES (1, @rule_version, @last_rebuilt_at, @last_error,
             @source_session_count, @indexed_session_count,
             @embedded_session_count, @no_summary_session_count,
             @error_session_count, @skipped_unchanged_count,
             @projection_method, @projected_session_count,
             @duration_ms, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       rule_version=excluded.rule_version,
       last_rebuilt_at=excluded.last_rebuilt_at,
       last_error=excluded.last_error,
       source_session_count=excluded.source_session_count,
       indexed_session_count=excluded.indexed_session_count,
       embedded_session_count=excluded.embedded_session_count,
       no_summary_session_count=excluded.no_summary_session_count,
       error_session_count=excluded.error_session_count,
       skipped_unchanged_count=excluded.skipped_unchanged_count,
       projection_method=excluded.projection_method,
       projected_session_count=excluded.projected_session_count,
       duration_ms=excluded.duration_ms,
       updated_at=excluded.updated_at`
  ).run(state);
}

export function isCosmosStateStale(db: Database.Database): boolean {
  const state = getCosmosState(db);
  return state != null && state.rule_version !== COSMOS_RULE_VERSION;
}

export function getCosmosPoint(
  db: Database.Database,
  sessionId: string
): CosmosPointRow | null {
  return (
    (db
      .prepare(
        `SELECT session_id, source, source_path, source_mtime_ms, source_size_bytes,
                project_key, project_path, total_tokens, x, y, cluster_id,
                token_status, embedding_status, missing_since, source_seen_at, updated_at
         FROM work_cosmos_points
         WHERE session_id = ?`
      )
      .get(sessionId) as CosmosPointRow | undefined) ?? null
  );
}

export function upsertCosmosPoint(
  db: Database.Database,
  row: CosmosPointRow
): void {
  db.prepare(
    `INSERT INTO work_cosmos_points
       (session_id, source, source_path, source_mtime_ms, source_size_bytes,
        project_key, project_path, total_tokens, x, y, cluster_id,
        token_status, embedding_status, missing_since, source_seen_at, updated_at)
     VALUES (@session_id, @source, @source_path, @source_mtime_ms, @source_size_bytes,
             @project_key, @project_path, @total_tokens, @x, @y, @cluster_id,
             @token_status, @embedding_status, @missing_since, @source_seen_at, @updated_at)
     ON CONFLICT(session_id) DO UPDATE SET
       source=excluded.source,
       source_path=excluded.source_path,
       source_mtime_ms=excluded.source_mtime_ms,
       source_size_bytes=excluded.source_size_bytes,
       project_key=excluded.project_key,
       project_path=excluded.project_path,
       total_tokens=excluded.total_tokens,
       x=excluded.x,
       y=excluded.y,
       cluster_id=excluded.cluster_id,
       token_status=excluded.token_status,
       embedding_status=excluded.embedding_status,
       missing_since=excluded.missing_since,
       source_seen_at=excluded.source_seen_at,
       updated_at=excluded.updated_at`
  ).run(row);
}

export function markCosmosPointSeen(
  db: Database.Database,
  sessionId: string,
  seenAt: string
): void {
  db.prepare(
    `UPDATE work_cosmos_points
     SET source_seen_at = ?, missing_since = NULL
     WHERE session_id = ?`
  ).run(seenAt, sessionId);
}

export function markUnseenCosmosPointsMissing(
  db: Database.Database,
  seen: Set<string>,
  missingAt: string
): number {
  const rows = db
    .prepare(
      `SELECT session_id FROM work_cosmos_points WHERE missing_since IS NULL`
    )
    .all() as { session_id: string }[];
  const tx = db.transaction((ids: string[]) => {
    const stmt = db.prepare(
      `UPDATE work_cosmos_points SET missing_since = ? WHERE session_id = ?`
    );
    for (const id of ids) stmt.run(missingAt, id);
  });
  const toMark = rows.map((r) => r.session_id).filter((id) => !seen.has(id));
  tx(toMark);
  return toMark.length;
}

export function updateCosmosPointEmbeddingStatus(
  db: Database.Database,
  sessionId: string,
  status: CosmosEmbeddingStatus,
  updatedAt: string
): void {
  db.prepare(
    `UPDATE work_cosmos_points
     SET embedding_status = ?, updated_at = ?
     WHERE session_id = ?`
  ).run(status, updatedAt, sessionId);
}

export function updateCosmosPointProjection(
  db: Database.Database,
  sessionId: string,
  x: number,
  y: number,
  updatedAt: string
): void {
  db.prepare(
    `UPDATE work_cosmos_points
     SET x = ?, y = ?, updated_at = ?
     WHERE session_id = ?`
  ).run(x, y, updatedAt, sessionId);
}

export function getCosmosEmbedding(
  db: Database.Database,
  sessionId: string
): CosmosEmbeddingRow | null {
  return (
    (db
      .prepare(
        `SELECT session_id, embedding_dim, vector, summary, updated_at
         FROM work_cosmos_embeddings
         WHERE session_id = ?`
      )
      .get(sessionId) as CosmosEmbeddingRow | undefined) ?? null
  );
}

export function upsertCosmosEmbedding(
  db: Database.Database,
  row: CosmosEmbeddingRow
): void {
  db.prepare(
    `INSERT INTO work_cosmos_embeddings
       (session_id, embedding_dim, vector, summary, updated_at)
     VALUES (@session_id, @embedding_dim, @vector, @summary, @updated_at)
     ON CONFLICT(session_id) DO UPDATE SET
       embedding_dim=excluded.embedding_dim,
       vector=excluded.vector,
       summary=excluded.summary,
       updated_at=excluded.updated_at`
  ).run(row);
}

/**
 * `work_cosmos_embeddings` 把 vector 与 summary 同时持有。projection 步骤
 * 只需要 vector + session_id，不读 summary。返回 Buffer / dim pair。
 */
export function listCosmosVectorsForProjection(
  db: Database.Database
): { session_id: string; embedding_dim: number; vector: Buffer }[] {
  return db
    .prepare(
      `SELECT e.session_id, e.embedding_dim, e.vector
       FROM work_cosmos_embeddings e
       JOIN work_cosmos_points p ON p.session_id = e.session_id
       WHERE p.missing_since IS NULL
         AND p.embedding_status = 'ok'
       ORDER BY e.session_id ASC`
    )
    .all() as { session_id: string; embedding_dim: number; vector: Buffer }[];
}

/** API-safe row read — purposely omits embeddings table. */
export function listCosmosPointsForApi(
  db: Database.Database
): Omit<CosmosPointRow, "source_path" | "source_mtime_ms" | "source_size_bytes">[] {
  return db
    .prepare(
      `SELECT session_id, source, project_key, project_path,
              total_tokens, x, y, cluster_id,
              token_status, embedding_status, missing_since,
              source_seen_at, updated_at
       FROM work_cosmos_points
       WHERE missing_since IS NULL
         AND x IS NOT NULL AND y IS NOT NULL
         AND embedding_status = 'ok'
       ORDER BY session_id ASC`
    )
    .all() as Omit<
      CosmosPointRow,
      "source_path" | "source_mtime_ms" | "source_size_bytes"
    >[];
}
