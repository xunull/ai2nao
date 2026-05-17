export type RagFileStatus =
  | "indexed"
  | "skipped"
  | "partial"
  | "error"
  | "deleted";

export type RagFileFtsStatus =
  | "none"
  | "indexed"
  | "deleted"
  | "error";

export type RagFileVectorStatus =
  | "none"
  | "indexed"
  | "deleted"
  | "error"
  | "unavailable";

export type RagIngestActionKind =
  | "skip"
  | "index_new"
  | "index_changed"
  | "delete_missing"
  | "repair"
  | "force_rebuild";

export type RagFileManifest = {
  sourceRoot: string;
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
  fileSha256: string | null;
  status: RagFileStatus;
  ftsStatus: RagFileFtsStatus;
  vectorStatus: RagFileVectorStatus;
  chunkCount: number;
  embeddingModel: string | null;
  embeddingDim: number | null;
  vectorProvider: string | null;
  lastIndexedAt: string | null;
  deletedAt: string | null;
  lastError: string | null;
};

export type RagManifestCounts = {
  total: number;
  indexed: number;
  skipped: number;
  partial: number;
  error: number;
  deleted: number;
  ftsError: number;
  vectorError: number;
};
