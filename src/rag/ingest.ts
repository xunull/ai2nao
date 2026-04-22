import type Database from "better-sqlite3";
import { chunkText } from "./chunk.js";
import { deleteChunksForFile } from "./dbChunks.js";
import {
  fetchEmbeddingsBatch,
  float32ToBlob,
} from "./embeddings.js";
import {
  type CorpusFileEntry,
  listCorpusFiles,
  readFileLimited,
} from "./walkFiles.js";
import { sha256Hex } from "./sha256.js";
import type { RagConfigV1 } from "./types.js";
import { effectiveCorpusRoots } from "./config.js";
import { minimalRagConfig } from "./defaultConfig.js";

export type IngestResult = {
  roots: number;
  filesSeen: number;
  filesIndexed: number;
  chunksInserted: number;
  errors: string[];
};

/** 处理每个待索引文件时回调（1-based current / total），用于终端进度。 */
export type IngestFileProgress = {
  current: number;
  total: number;
  relPath: string;
};

export type IngestCorpusOptions = {
  onProgress?: (p: IngestFileProgress) => void;
};

/**
 * Index all files under effective corpus roots into `db`.
 * @param cliRoots if non-empty, overrides config roots
 */
export async function ingestCorpus(
  db: Database.Database,
  cfg: RagConfigV1 | null,
  cliRoots: string[],
  options?: IngestCorpusOptions
): Promise<IngestResult> {
  const { roots, error } = effectiveCorpusRoots(cfg, cliRoots);
  if (error || roots.length === 0) {
    return {
      roots: 0,
      filesSeen: 0,
      filesIndexed: 0,
      chunksInserted: 0,
      errors: [error ?? "no roots"],
    };
  }

  const effective = cfg ?? minimalRagConfig(roots);

  const extSet = new Set(effective.includeExtensions.map((e) => e.toLowerCase()));
  const errors: string[] = [];
  let filesSeen = 0;
  let filesIndexed = 0;
  let chunksInserted = 0;

  const insertNoEmb = db.prepare(`
    INSERT INTO rag_chunks (source_root, file_path, chunk_index, content, mtime_ms, content_sha256, embedding_dim, embedding)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
  `);
  const insertFts = db.prepare(`
    INSERT INTO rag_chunks_fts (chunk_id, source_root, file_path, content)
    VALUES (?, ?, ?, ?)
  `);
  const insertWithEmb = db.prepare(`
    INSERT INTO rag_chunks (source_root, file_path, chunk_index, content, mtime_ms, content_sha256, embedding_dim, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const onProgress = options?.onProgress;
  const queue: { root: string; f: CorpusFileEntry }[] = [];
  for (const root of roots) {
    const listed = listCorpusFiles(root, extSet, effective.respectDefaultExcludes);
    for (const w of listed.warnings) {
      errors.push(w);
    }
    for (const f of listed.files) {
      queue.push({ root, f });
    }
  }
  const totalQueued = queue.length;
  let fileOrdinal = 0;
  for (const { root, f } of queue) {
    fileOrdinal++;
    onProgress?.({ current: fileOrdinal, total: totalQueued, relPath: f.relPath });
    filesSeen++;
    const read = readFileLimited(
        f.absPath,
        f.relPath,
        f.mtimeMs,
        effective.maxFileBytes
    );
    if (!read.ok) {
      errors.push(read.error);
      continue;
    }
    const { data } = read;
    const chunks = chunkText(data.body);
    if (chunks.length === 0) continue;

    deleteChunksForFile(db, root, data.relPath);

    const chunkRows: {
      sourceRoot: string;
      filePath: string;
      idx: number;
      content: string;
      mtime: number;
      sha: string;
    }[] = [];
    chunks.forEach((content, idx) => {
      chunkRows.push({
        sourceRoot: root,
        filePath: data.relPath,
        idx,
        content,
        mtime: data.mtimeMs,
        sha: sha256Hex(content),
      });
    });

    if (effective.embedding?.enabled) {
      let embBatch: { dim: number; vector: Float32Array }[] = [];
      try {
        embBatch = await fetchEmbeddingsBatch(chunks, effective);
      } catch (e) {
        errors.push(
          `embed failed for ${data.relPath}: ${e instanceof Error ? e.message : String(e)}`
        );
        db.transaction(() => {
          for (const row of chunkRows) {
            const info = insertNoEmb.run(
              row.sourceRoot,
              row.filePath,
              row.idx,
              row.content,
              row.mtime,
              row.sha
            );
            const chunkId = Number(info.lastInsertRowid);
            insertFts.run(chunkId, row.sourceRoot, row.filePath, row.content);
            chunksInserted++;
          }
        })();
        filesIndexed++;
        continue;
      }
      if (embBatch.length !== chunkRows.length) {
        errors.push(
          `embed count mismatch for ${data.relPath}: expected ${chunkRows.length}, got ${embBatch.length}`
        );
        continue;
      }
      db.transaction(() => {
        for (let i = 0; i < chunkRows.length; i++) {
          const row = chunkRows[i]!;
          const em = embBatch[i]!;
          const blob = float32ToBlob(em.vector);
          const info = insertWithEmb.run(
            row.sourceRoot,
            row.filePath,
            row.idx,
            row.content,
            row.mtime,
            row.sha,
            em.dim,
            blob
          );
          const chunkId = Number(info.lastInsertRowid);
          insertFts.run(chunkId, row.sourceRoot, row.filePath, row.content);
          chunksInserted++;
        }
      })();
    } else {
      db.transaction(() => {
        for (const row of chunkRows) {
          const info = insertNoEmb.run(
            row.sourceRoot,
            row.filePath,
            row.idx,
            row.content,
            row.mtime,
            row.sha
          );
          const chunkId = Number(info.lastInsertRowid);
          insertFts.run(chunkId, row.sourceRoot, row.filePath, row.content);
          chunksInserted++;
        }
      })();
    }
    filesIndexed++;
  }

  return {
    roots: roots.length,
    filesSeen,
    filesIndexed,
    chunksInserted,
    errors,
  };
}

/** Simpler sync ingest for tests (no embeddings). */
export function ingestCorpusSync(
  db: Database.Database,
  cfg: RagConfigV1,
  cliRoots: string[]
): IngestResult {
  const { roots, error } = effectiveCorpusRoots(cfg, cliRoots);
  if (error || roots.length === 0) {
    return {
      roots: 0,
      filesSeen: 0,
      filesIndexed: 0,
      chunksInserted: 0,
      errors: [error ?? "no roots"],
    };
  }
  if (cfg.embedding?.enabled) {
    return {
      roots: roots.length,
      filesSeen: 0,
      filesIndexed: 0,
      chunksInserted: 0,
      errors: ["ingestCorpusSync: turn off embedding or use ingestCorpus async"],
    };
  }

  const extSet = new Set(cfg.includeExtensions.map((e) => e.toLowerCase()));
  const errors: string[] = [];
  let filesSeen = 0;
  let filesIndexed = 0;
  let chunksInserted = 0;

  const insertNoEmb = db.prepare(`
    INSERT INTO rag_chunks (source_root, file_path, chunk_index, content, mtime_ms, content_sha256, embedding_dim, embedding)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
  `);
  const insertFts = db.prepare(`
    INSERT INTO rag_chunks_fts (chunk_id, source_root, file_path, content)
    VALUES (?, ?, ?, ?)
  `);

  for (const root of roots) {
    const listed = listCorpusFiles(root, extSet, cfg.respectDefaultExcludes);
    for (const w of listed.warnings) {
      errors.push(w);
    }
    for (const f of listed.files) {
      filesSeen++;
      const read = readFileLimited(f.absPath, f.relPath, f.mtimeMs, cfg.maxFileBytes);
      if (!read.ok) {
        errors.push(read.error);
        continue;
      }
      const { data } = read;
      const chunks = chunkText(data.body);
      if (chunks.length === 0) continue;
      deleteChunksForFile(db, root, data.relPath);
      db.transaction(() => {
        chunks.forEach((content, idx) => {
          const sha = sha256Hex(content);
          const info = insertNoEmb.run(
            root,
            data.relPath,
            idx,
            content,
            data.mtimeMs,
            sha
          );
          const chunkId = Number(info.lastInsertRowid);
          insertFts.run(chunkId, root, data.relPath, content);
          chunksInserted++;
        });
      })();
      filesIndexed++;
    }
  }

  return {
    roots: roots.length,
    filesSeen,
    filesIndexed,
    chunksInserted,
    errors,
  };
}
