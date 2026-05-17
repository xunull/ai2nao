import type Database from "better-sqlite3";
import { ensureRagMetaTable } from "./meta.js";

const CURRENT_VERSION = 2;

export function migrateRag(db: Database.Database): void {
  db.exec("PRAGMA foreign_keys = ON;");
  const exists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='rag_meta_schema'"
    )
    .get() as { 1: number } | undefined;
  if (!exists) {
    applyV1(db);
    return;
  }
  const row = db.prepare("SELECT version FROM rag_meta_schema WHERE id = 1").get() as
    | { version: number }
    | undefined;
  const v = row?.version ?? 0;
  if (v < 1) applyV1(db);
  if (v < 2) applyV2(db);
  const vAfter = (
    db.prepare("SELECT version FROM rag_meta_schema WHERE id = 1").get() as {
      version: number;
    }
  ).version;
  if (vAfter > CURRENT_VERSION) {
    throw new Error(
      `RAG database schema newer than this binary (version ${vAfter}); upgrade ai2nao`
    );
  }
  ensureRagMetaTable(db);
}

function applyV1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rag_meta_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO rag_meta_schema (id, version) VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS rag_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_root TEXT NOT NULL,
      file_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      content_sha256 TEXT NOT NULL,
      embedding_dim INTEGER,
      embedding BLOB,
      UNIQUE(source_root, file_path, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS idx_rag_chunks_root_file ON rag_chunks(source_root, file_path);

    CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      source_root UNINDEXED,
      file_path UNINDEXED,
      content,
      tokenize = 'porter unicode61'
    );
  `);
  db.prepare("UPDATE rag_meta_schema SET version = ? WHERE id = 1").run(
    1
  );
  ensureRagMetaTable(db);
  applyV2(db);
}

function applyV2(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rag_files (
      source_root TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      file_sha256 TEXT,
      status TEXT NOT NULL,
      fts_status TEXT NOT NULL,
      vector_status TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      embedding_model TEXT,
      embedding_dim INTEGER,
      vector_provider TEXT,
      last_indexed_at TEXT,
      deleted_at TEXT,
      last_error TEXT,
      PRIMARY KEY (source_root, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_rag_files_status ON rag_files(status);
    CREATE INDEX IF NOT EXISTS idx_rag_files_vector_status ON rag_files(vector_status);
    CREATE INDEX IF NOT EXISTS idx_rag_files_deleted_at ON rag_files(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_rag_files_repair ON rag_files(status, fts_status, vector_status);
  `);
  db.prepare("UPDATE rag_meta_schema SET version = ? WHERE id = 1").run(
    CURRENT_VERSION
  );
}
