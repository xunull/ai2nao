import type Database from "better-sqlite3";
import type { ToolSet } from "ai";
import type { SessionMemoryService } from "../sessionMemory/index.js";
import type { WebSearchService } from "../webSearch/service.js";
import { parseForwardedToolProps } from "./forwardedProps.js";
import { createRagEvidenceTool } from "./ragEvidenceTool.js";
import { createSessionMemoryTool } from "./sessionMemoryTool.js";
import { createWebSearchTool } from "./webSearchTool.js";

export type Ai2NaoToolDeps = {
  db?: Database.Database;
  ragDb?: Database.Database;
  webSearch?: WebSearchService;
  sessionMemory?: SessionMemoryService;
};

export function buildAi2NaoServerTools(
  deps: Ai2NaoToolDeps,
  forwardedProps: unknown
) {
  const props = parseForwardedToolProps(forwardedProps);
  const tools: ToolSet = {};

  if (props.useRag) {
    tools.ai2nao_search_rag_evidence = createRagEvidenceTool(deps.ragDb, props.ragTopK);
  }

  if (props.webSearchEnabled) {
    tools.ai2nao_web_search = createWebSearchTool(deps.webSearch, props.webSearchEnabled);
  }

  if (props.sessionMemoryEnabled) {
    tools.ai2nao_search_session_memory = createSessionMemoryTool({
      db: deps.db,
      sessionMemory: deps.sessionMemory,
      defaultCount: props.sessionMemoryTopK,
    });
  }

  return tools;
}
