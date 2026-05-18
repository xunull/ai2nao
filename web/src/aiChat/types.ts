export type LlmChatStatus = {
  configured: boolean;
  provider: string | null;
  model: string | null;
  baseHost: string | null;
  configPath: string;
};

export type RagStatus = {
  ok: true;
  dbPath: string;
  configPath: string;
  defaultDbPath: string;
  configPresent: boolean;
  corpusRoots: string[];
  embeddingEnabled: boolean;
  chunkCount: number;
  manifest: {
    total: number;
    indexed: number;
    skipped: number;
    partial: number;
    error: number;
    deleted: number;
    ftsError: number;
    vectorError: number;
  };
  vectorStore: {
    provider: "none" | "lancedb";
    path: string | null;
    ok: boolean;
    indexedCount: number;
    syncStatus: string;
    embeddingModel: string | null;
    embeddingDim: number | null;
    error: string | null;
  };
};

export type WebSearchStatus = {
  provider: "brave";
  configured: boolean;
  ok: boolean;
  configPath: string;
  capabilities: {
    freshness: boolean;
    safeSearch: boolean;
    resultLanguage: boolean;
    pageFetch: boolean;
  };
  cacheTtlMs: number;
  error: string | null;
};

export type RagEvidenceHit = {
  id?: number;
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
  matchedBy: ("fts" | "vector")[];
};

export type AiChatSessionSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  message_count: number;
};

export type AiChatStoredMessage = {
  id: string;
  session_id: string;
  message_id: string;
  message_index: number;
  role: "developer" | "system" | "user" | "assistant" | "tool" | "activity" | "reasoning";
  raw_json: string;
  plain_text: string;
  preview: string;
  status: string | null;
  created_at: string;
  updated_at: string;
};

export type AiChatSessionDetail = AiChatSessionSummary & {
  messages: AiChatStoredMessage[];
};
