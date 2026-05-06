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
  configPresent: boolean;
  corpusRoots: string[];
  embeddingEnabled: boolean;
  chunkCount: number;
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
  role: "system" | "user" | "assistant";
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
