import type Database from "better-sqlite3";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { AiEvidenceItem, AiEvidenceToolResult } from "../aiEvidence.js";
import { readRagConfig } from "../rag/config.js";
import { countChunks, searchHybridDetailed } from "../rag/retrieve.js";
import type { WebSearchService } from "../webSearch/service.js";
import { getDefaultWebSearchService } from "../webSearch/service.js";

export type Ai2NaoToolDeps = {
  ragDb?: Database.Database;
  webSearch?: WebSearchService;
};

type ForwardedToolProps = {
  useRag: boolean;
  ragTopK: number;
  webSearchEnabled: boolean;
};

const ragSearchInput = z.object({
  query: z.string().describe("Public or local-material search query for ai2nao local RAG."),
  reason: z.string().optional().describe("Why local evidence is needed."),
  topK: z.number().optional().describe("Number of local evidence items to return."),
});
type RagSearchInput = z.infer<typeof ragSearchInput>;

const webSearchInput = z.object({
  query: z.string().describe("Short public web search query. Do not include private paths, emails, or tokens."),
  reason: z.string().optional().describe("Why current web evidence is needed."),
  count: z.number().optional().describe("Number of web results to return."),
});
type WebSearchInput = z.infer<typeof webSearchInput>;

export function buildAi2NaoServerTools(
  deps: Ai2NaoToolDeps,
  forwardedProps: unknown
) {
  const props = parseForwardedToolProps(forwardedProps);
  const tools: ToolSet = {};

  if (props.useRag) {
    tools.ai2nao_search_rag_evidence = tool<RagSearchInput, AiEvidenceToolResult>({
      description:
        "Search the user's local ai2nao RAG index and return structured LOCAL evidence. Use this for indexed local project notes, docs, and previous context.",
      inputSchema: ragSearchInput,
      execute: async ({ query, reason, topK }): Promise<AiEvidenceToolResult> => {
        return searchLocalRagEvidence(deps.ragDb, query, reason, topK ?? props.ragTopK);
      },
    });
  }

  if (props.webSearchEnabled) {
    const webSearch = deps.webSearch ?? getDefaultWebSearchService();
    tools.ai2nao_web_search = tool<WebSearchInput, AiEvidenceToolResult>({
      description:
        "Search the public web and return structured WEB evidence. Use this for current, external, or internet-only information. Query must be short and public-safe.",
      inputSchema: webSearchInput,
      execute: async ({ query, reason, count }, options): Promise<AiEvidenceToolResult> => {
        return webSearch.search(
          { query, reason, count },
          { enabled: props.webSearchEnabled, signal: options.abortSignal }
        );
      },
    });
  }

  return tools;
}

export function parseForwardedToolProps(input: unknown): ForwardedToolProps {
  const props = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const rawRagTopK = parseInt(String(props.ragTopK ?? 8), 10);
  return {
    useRag: props.useRag === true,
    ragTopK: Math.min(20, Math.max(1, rawRagTopK || 8)),
    webSearchEnabled: props.webSearchEnabled === true,
  };
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
