import type Database from "better-sqlite3";
import { tool } from "ai";
import { z } from "zod";
import {
  createSessionMemoryService,
  type SessionMemoryService,
  type SessionMemorySource,
} from "../sessionMemory/index.js";
import type { AiEvidenceToolResult } from "./evidence.js";

const sessionMemoryInput = z.object({
  query: z.string().describe("Search query for the user's local AI/session history."),
  reason: z.string().optional().describe("Why local session memory is needed."),
  count: z.number().optional().describe("Number of session memory evidence items to return."),
  sources: z
    .array(z.enum(["ai-chat", "codex", "claude-code", "cursor"]))
    .optional()
    .describe("Optional local session sources to search."),
});
type SessionMemoryInput = z.infer<typeof sessionMemoryInput>;

export function createSessionMemoryTool(options: {
  db?: Database.Database;
  sessionMemory?: SessionMemoryService;
  defaultCount: number;
}) {
  const sessionMemory =
    options.sessionMemory ?? createSessionMemoryService({ db: options.db });
  return tool<SessionMemoryInput, AiEvidenceToolResult>({
    description:
      "Search the user's local AI session history across ai2nao AI Chat, Codex, Claude Code, and Cursor. Returns short LOCAL session-memory evidence snippets only.",
    inputSchema: sessionMemoryInput,
    execute: async ({ query, reason, count, sources }, execOptions): Promise<AiEvidenceToolResult> => {
      return sessionMemory.search(
        {
          query,
          reason,
          count: count ?? options.defaultCount,
          sources: sources as SessionMemorySource[] | undefined,
        },
        { signal: execOptions.abortSignal }
      );
    },
  });
}
