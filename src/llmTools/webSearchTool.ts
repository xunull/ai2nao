import { tool } from "ai";
import { z } from "zod";
import { getDefaultWebSearchService, type WebSearchService } from "../webSearch/service.js";
import type { AiEvidenceToolResult } from "./evidence.js";

const webSearchInput = z.object({
  query: z.string().describe("Short public web search query. Do not include private paths, emails, or tokens."),
  reason: z.string().optional().describe("Why current web evidence is needed."),
  count: z.number().optional().describe("Number of web results to return."),
});
type WebSearchInput = z.infer<typeof webSearchInput>;

export function createWebSearchTool(
  webSearch: WebSearchService | undefined,
  enabled: boolean
) {
  const service = webSearch ?? getDefaultWebSearchService();
  return tool<WebSearchInput, AiEvidenceToolResult>({
    description:
      "Search the public web and return structured WEB evidence. Use this for current, external, or internet-only information. Query must be short and public-safe.",
    inputSchema: webSearchInput,
    execute: async ({ query, reason, count }, options): Promise<AiEvidenceToolResult> => {
      return service.search(
        { query, reason, count },
        { enabled, signal: options.abortSignal }
      );
    },
  });
}
