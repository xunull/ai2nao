export type RagEvidenceMatchKind = "fts" | "vector";

export type RagEvidenceHit = {
  chunkId: number;
  sourceRoot: string;
  filePath: string;
  content: string;
  contentPreview: string;
  truncated: boolean;
  scores: {
    ftsRank?: number;
    vectorScore?: number;
    rrfScore: number;
  };
  ranks: {
    fts?: number;
    vector?: number;
    hybrid: number;
  };
  matchedBy: RagEvidenceMatchKind[];
};

export type RagSearchBranchError = {
  branch: "fts" | "vector";
  message: string;
};

export type RagSearchMeta = {
  vectorProvider: "none" | "lancedb";
  vectorAvailable: boolean;
  vectorStaleReason?: string;
  queryEmbeddingDim?: number;
  errors: RagSearchBranchError[];
};

export type RagSearchResult = {
  query: string;
  hits: RagEvidenceHit[];
  fts: RagEvidenceHit[];
  vector: RagEvidenceHit[];
  meta: RagSearchMeta;
};

export function previewContent(content: string, max = 1200): {
  contentPreview: string;
  truncated: boolean;
} {
  if (content.length <= max) {
    return { contentPreview: content, truncated: false };
  }
  return { contentPreview: `${content.slice(0, max)}...`, truncated: true };
}
