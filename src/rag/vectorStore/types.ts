export type RagVectorHit = {
  chunkId: number;
  score: number;
};

export type RagVectorChunk = {
  chunkId: number;
  sourceRoot: string;
  filePath: string;
  chunkIndex: number;
  contentSha256: string;
  embedding: Float32Array;
};

export type RagVectorStoreStatus = {
  ok: boolean;
  provider: "none" | "lancedb";
  indexedCount?: number;
  error?: string;
};

export type RagVectorStore = {
  provider: "none" | "lancedb";
  status(): Promise<RagVectorStoreStatus>;
  upsertChunks(chunks: RagVectorChunk[]): Promise<void>;
  deleteFile(sourceRoot: string, filePath: string): Promise<void>;
  optimize?(): Promise<void>;
  search(queryEmbedding: Float32Array, topK: number): Promise<RagVectorHit[]>;
};
