import type {
  RagVectorChunk,
  RagVectorHit,
  RagVectorStore,
  RagVectorStoreStatus,
} from "./types.js";

export class NullVectorStore implements RagVectorStore {
  provider = "none" as const;

  async status(): Promise<RagVectorStoreStatus> {
    return { ok: true, provider: "none", indexedCount: 0 };
  }

  async upsertChunks(_chunks: RagVectorChunk[]): Promise<void> {
    return undefined;
  }

  async deleteFile(_sourceRoot: string, _filePath: string): Promise<void> {
    return undefined;
  }

  async optimize(): Promise<void> {
    return undefined;
  }

  async search(_queryEmbedding: Float32Array, _topK: number): Promise<RagVectorHit[]> {
    return [];
  }
}
