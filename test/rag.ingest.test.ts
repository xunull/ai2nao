import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRagDatabase } from "../src/rag/open.js";
import { ingestCorpus } from "../src/rag/ingest.js";
import {
  cleanupDeletedRagFileManifests,
  getRagFileManifest,
  markRagFileDeleted,
} from "../src/rag/manifest.js";
import { countChunks } from "../src/rag/retrieve.js";
import { searchFts, searchHybridDetailed } from "../src/rag/retrieve.js";
import type { RagConfigV1 } from "../src/rag/types.js";
import type { RagVectorStore } from "../src/rag/vectorStore/types.js";

describe("rag ingest + fts", () => {
  const dbs: ReturnType<typeof openRagDatabase>[] = [];

  afterEach(() => {
    for (const db of dbs) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    dbs.length = 0;
  });

  it("indexes markdown and finds text", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai2nao-rag-"));
    const sub = join(root, "notes");
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, "hello.md"),
      "# Hi\n\nThis is a unique token xyzzyalpha for rag test.\n",
      "utf8"
    );

    const dbPath = join(root, "rag.db");
    const db = openRagDatabase(dbPath);
    dbs.push(db);

    const cfg: RagConfigV1 = {
      version: 1,
      corpusRoots: [sub],
      includeExtensions: [".md"],
      maxFileBytes: 1_000_000,
      respectDefaultExcludes: true,
    };

    const result = await ingestCorpus(db, cfg, []);
    expect(result.errors.length).toBe(0);
    expect(result.chunksInserted).toBeGreaterThan(0);

    const hits = searchFts(db, "xyzzyalpha", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content).toContain("xyzzyalpha");
  });

  it("skips unchanged files and tombstones missing files", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai2nao-rag-"));
    const sub = join(root, "notes");
    mkdirSync(sub, { recursive: true });
    const filePath = join(sub, "hello.md");
    writeFileSync(filePath, "# Hi\n\nThis is a unique token tombstone-alpha.\n", "utf8");

    const dbPath = join(root, "rag.db");
    const db = openRagDatabase(dbPath);
    dbs.push(db);

    const cfg: RagConfigV1 = {
      version: 1,
      corpusRoots: [sub],
      includeExtensions: [".md"],
      maxFileBytes: 1_000_000,
      respectDefaultExcludes: true,
    };

    const first = await ingestCorpus(db, cfg, []);
    expect(first.filesIndexed).toBe(1);
    expect(first.filesSkipped).toBe(0);

    const second = await ingestCorpus(db, cfg, []);
    expect(second.filesIndexed).toBe(0);
    expect(second.filesSkipped).toBe(1);

    writeFileSync(join(sub, "new.md"), "# New\n\nrepair mode should not index this.\n", "utf8");
    const repair = await ingestCorpus(db, cfg, [], { repair: true });
    expect(repair.filesIndexed).toBe(0);
    expect(repair.plan.index_new).toBe(0);
    expect(repair.plan.repair).toBe(0);

    unlinkSync(filePath);
    const third = await ingestCorpus(db, cfg, []);
    expect(third.filesDeleted).toBe(1);
    expect(searchFts(db, "tombstone-alpha", 10)).toHaveLength(0);

    const manifest = getRagFileManifest(db, sub, "hello.md");
    expect(manifest?.status).toBe("deleted");
    expect(manifest?.ftsStatus).toBe("deleted");
  });

  it("dry-runs without writing chunks or manifest rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai2nao-rag-"));
    const sub = join(root, "notes");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "dry.md"), "# Dry\n\nThis should only be planned.\n", "utf8");

    const dbPath = join(root, "rag.db");
    const db = openRagDatabase(dbPath);
    dbs.push(db);

    const cfg: RagConfigV1 = {
      version: 1,
      corpusRoots: [sub],
      includeExtensions: [".md"],
      maxFileBytes: 1_000_000,
      respectDefaultExcludes: true,
    };

    const result = await ingestCorpus(db, cfg, [], { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.plan.index_new).toBe(1);
    expect(result.filesIndexed).toBe(0);
    expect(countChunks(db)).toBe(0);
    expect(getRagFileManifest(db, sub, "dry.md")).toBeNull();
  });

  it("cleans up only expired deleted manifest tombstones", () => {
    const root = mkdtempSync(join(tmpdir(), "ai2nao-rag-"));
    const dbPath = join(root, "rag.db");
    const db = openRagDatabase(dbPath);
    dbs.push(db);

    markRagFileDeleted(db, {
      sourceRoot: root,
      filePath: "old.md",
      vectorStatus: "deleted",
      deletedAt: "2026-01-01T00:00:00.000Z",
      lastError: null,
    });
    markRagFileDeleted(db, {
      sourceRoot: root,
      filePath: "fresh.md",
      vectorStatus: "deleted",
      deletedAt: "2026-05-17T00:00:00.000Z",
      lastError: null,
    });

    const deleted = cleanupDeletedRagFileManifests(
      db,
      new Date("2026-02-01T00:00:00.000Z")
    );
    expect(deleted).toBe(1);
    expect(getRagFileManifest(db, root, "old.md")).toBeNull();
    expect(getRagFileManifest(db, root, "fresh.md")?.status).toBe("deleted");
  });

  it("includes vector-only hits in hybrid search", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai2nao-rag-"));
    const dbPath = join(root, "rag.db");
    const db = openRagDatabase(dbPath);
    dbs.push(db);

    const insertChunk = db.prepare(`
      INSERT INTO rag_chunks (source_root, file_path, chunk_index, content, mtime_ms, content_sha256, embedding_dim, embedding)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
    `);
    const insertFts = db.prepare(`
      INSERT INTO rag_chunks_fts (chunk_id, source_root, file_path, content)
      VALUES (?, ?, ?, ?)
    `);

    const ftsId = Number(
      insertChunk.run(root, "fts.md", 0, "apple keyword match", 1, "a").lastInsertRowid
    );
    insertFts.run(ftsId, root, "fts.md", "apple keyword match");
    const vectorId = Number(
      insertChunk.run(root, "vector.md", 0, "semantic-only passage", 1, "b").lastInsertRowid
    );
    insertFts.run(vectorId, root, "vector.md", "semantic-only passage");

    const fakeStore: RagVectorStore = {
      provider: "lancedb",
      status: async () => ({ ok: true, provider: "lancedb", indexedCount: 1 }),
      upsertChunks: async () => undefined,
      deleteFile: async () => undefined,
      search: async () => [{ chunkId: vectorId, score: 0.9 }],
    };
    const cfg: RagConfigV1 = {
      version: 1,
      corpusRoots: [root],
      includeExtensions: [".md"],
      maxFileBytes: 1_000_000,
      respectDefaultExcludes: true,
      embedding: {
        enabled: true,
        baseURL: "http://example.invalid/v1",
        model: "test-embedding",
      },
      vectorStore: { provider: "lancedb", path: root },
    };

    const result = await searchHybridDetailed(db, "apple", 10, cfg, {
      vectorStore: fakeStore,
      queryVector: new Float32Array([1, 0]),
    });

    expect(result.fts.map((hit) => hit.filePath)).toContain("fts.md");
    expect(result.vector.map((hit) => hit.filePath)).toContain("vector.md");
    expect(result.hits.map((hit) => hit.filePath)).toContain("vector.md");
  });
});
