import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRagDatabase } from "../src/rag/open.js";
import { ingestCorpusSync } from "../src/rag/ingest.js";
import { searchFts } from "../src/rag/retrieve.js";
import type { RagConfigV1 } from "../src/rag/types.js";

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

  it("indexes markdown and finds text", () => {
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

    const result = ingestCorpusSync(db, cfg, []);
    expect(result.errors.length).toBe(0);
    expect(result.chunksInserted).toBeGreaterThan(0);

    const hits = searchFts(db, "xyzzyalpha", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content).toContain("xyzzyalpha");
  });
});
