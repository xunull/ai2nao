import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { Table } from "@lancedb/lancedb";
import type {
  RagVectorChunk,
  RagVectorHit,
  RagVectorStore,
  RagVectorStoreStatus,
} from "./types.js";

const TABLE_NAME = "rag_chunks";

type LanceRow = {
  chunkId: number;
  vector: number[];
  sourceRoot: string;
  filePath: string;
  chunkIndex: number;
  contentSha256: string;
};

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function rowsFromChunks(chunks: RagVectorChunk[]): LanceRow[] {
  return chunks.map((chunk) => ({
    chunkId: chunk.chunkId,
    vector: Array.from(chunk.embedding),
    sourceRoot: chunk.sourceRoot,
    filePath: chunk.filePath,
    chunkIndex: chunk.chunkIndex,
    contentSha256: chunk.contentSha256,
  }));
}

export class LanceDbVectorStore implements RagVectorStore {
  provider = "lancedb" as const;
  private tablePromise: Promise<Table | null> | null = null;

  constructor(private readonly path: string) {}

  async status(): Promise<RagVectorStoreStatus> {
    try {
      const table = await this.openTableIfExists();
      return {
        ok: true,
        provider: "lancedb",
        indexedCount: table ? await table.countRows() : 0,
      };
    } catch (e) {
      return {
        ok: false,
        provider: "lancedb",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async upsertChunks(chunks: RagVectorChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const rows = rowsFromChunks(chunks);
    const { table, created } = await this.openOrCreateTable(rows);
    if (created) return;
    await table
      .mergeInsert("chunkId")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows);
  }

  async deleteFile(sourceRoot: string, filePath: string): Promise<void> {
    const table = await this.openTableIfExists();
    if (!table) return;
    await table.delete(
      `sourceRoot = ${sqlString(sourceRoot)} AND filePath = ${sqlString(filePath)}`
    );
  }

  async optimize(): Promise<void> {
    const table = await this.openTableIfExists();
    if (!table) return;
    await table.optimize();
  }

  async search(queryEmbedding: Float32Array, topK: number): Promise<RagVectorHit[]> {
    const table = await this.openTableIfExists();
    if (!table) return [];
    const rows = (await table
      .vectorSearch(Array.from(queryEmbedding))
      .column("vector")
      .select(["chunkId", "_distance"])
      .limit(topK)
      .toArray()) as { chunkId?: number; _distance?: number }[];
    return rows
      .filter((row) => typeof row.chunkId === "number")
      .map((row) => ({
        chunkId: row.chunkId!,
        score: typeof row._distance === "number" ? -row._distance : 0,
      }));
  }

  private async openConnection() {
    mkdirSync(dirname(this.path), { recursive: true });
    return lancedb.connect(this.path);
  }

  private async openTableIfExists(): Promise<Table | null> {
    if (!this.tablePromise) {
      this.tablePromise = (async () => {
        const conn = await this.openConnection();
        const names = await conn.tableNames();
        if (!names.includes(TABLE_NAME)) return null;
        return conn.openTable(TABLE_NAME);
      })();
    }
    return this.tablePromise;
  }

  private async openOrCreateTable(seedRows: LanceRow[]): Promise<{ table: Table; created: boolean }> {
    const existing = await this.openTableIfExists();
    if (existing) return { table: existing, created: false };
    const conn = await this.openConnection();
    const table = await conn.createTable(TABLE_NAME, seedRows, {
      mode: "create",
      existOk: true,
    });
    this.tablePromise = Promise.resolve(table);
    return { table, created: true };
  }
}
