import type Database from "better-sqlite3";
import { tool } from "ai";
import { z } from "zod";
import { readRagConfig } from "../rag/config.js";
import { countChunks, searchHybridDetailed } from "../rag/retrieve.js";
import type { AiEvidenceItem, AiEvidenceToolResult } from "./evidence.js";

const ragSearchInput = z.object({
  query: z.string().describe("Public or local-material search query for ai2nao local RAG."),
  reason: z.string().optional().describe("Why local evidence is needed."),
  topK: z.number().optional().describe("Number of local evidence items to return."),
});
type RagSearchInput = z.infer<typeof ragSearchInput>;

export function createRagEvidenceTool(
  ragDb: Database.Database | undefined,
  defaultTopK: number
) {
  return tool<RagSearchInput, AiEvidenceToolResult>({
    description:
      "Search the user's local ai2nao RAG index and return structured LOCAL evidence. Use this for indexed local project notes, docs, and previous context.",
    inputSchema: ragSearchInput,
    execute: async ({ query, reason, topK }): Promise<AiEvidenceToolResult> => {
      return searchLocalRagEvidence(ragDb, query, reason, topK ?? defaultTopK);
    },
  });
}

async function searchLocalRagEvidence(
  ragDb: Database.Database | undefined,
  query: string,
  reason: string | undefined,
  topK: number
): Promise<AiEvidenceToolResult> {
  if (!ragDb) {
    return localEvidenceError("rag_unavailable", "RAG is not available on this server.", true);
  }
  if (countChunks(ragDb) === 0) {
    return localEvidenceError(
      "rag_empty",
      "RAG index is empty. Run ai2nao rag ingest before searching local evidence.",
      true
    );
  }
  const result = await searchHybridDetailed(ragDb, query, topK, readRagConfig());
  const generatedAt = new Date().toISOString();
  return {
    ok: true,
    kind: "evidence",
    source: "local",
    query,
    reason,
    generatedAt,
    evidence: result.hits.slice(0, topK).map<AiEvidenceItem>((hit, index) => ({
      id: `local-${hit.chunkId}`,
      source: "local",
      title: hit.filePath,
      path: hit.filePath,
      snippet: truncate(hit.contentPreview || hit.content, 800),
      rank: index + 1,
      provider: "rag",
      fetchedAt: generatedAt,
      matchedBy: hit.matchedBy,
    })),
    meta: {
      provider: "rag",
      durationMs: undefined,
    },
  };
}

function localEvidenceError(
  code: string,
  message: string,
  recoverable: boolean
): AiEvidenceToolResult {
  return {
    ok: false,
    kind: "evidence_error",
    source: "local",
    code,
    message,
    recoverable,
  };
}

function truncate(value: string, maxChars: number): string {
  const clean = value.trim().replace(/\s+/g, " ");
  return clean.length > maxChars ? `${clean.slice(0, Math.max(0, maxChars - 3))}...` : clean;
}
