import type Database from "better-sqlite3";
import type { ToolSet } from "ai";
import type { BashApprovalStore, BashPermissionRuleStore, BashToolService } from "../bashTool/index.js";
import type { CodeRunnerService } from "../codeRunner/index.js";
import type { SessionMemoryService } from "../sessionMemory/index.js";
import type { WebSearchService } from "../webSearch/service.js";
import { createBashTool } from "./bashTool.js";
import { parseForwardedToolProps } from "./forwardedProps.js";
import { createRagEvidenceTool } from "./ragEvidenceTool.js";
import { createRunCodeTool } from "./runCodeTool.js";
import { createSessionMemoryTool } from "./sessionMemoryTool.js";
import { createWebSearchTool } from "./webSearchTool.js";

export type Ai2NaoToolDeps = {
  db?: Database.Database;
  ragDb?: Database.Database;
  webSearch?: WebSearchService;
  sessionMemory?: SessionMemoryService;
  codeRunner?: CodeRunnerService;
  bashTool?: BashToolService;
  bashApprovalStore?: BashApprovalStore;
  bashPermissionRules?: BashPermissionRuleStore;
};

export function buildAi2NaoServerTools(
  deps: Ai2NaoToolDeps,
  forwardedProps: unknown,
  options?: { sessionId?: string }
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

  if (props.codeExecutionEnabled) {
    tools.ai2nao_run_code = createRunCodeTool(deps.codeRunner, {
      defaultTimeoutMs: props.codeExecutionTimeoutMs,
      defaultRuntime: props.codeExecutionRuntime,
      dockerEnabled: props.codeExecutionRuntime === "docker",
    });
  }

  if (props.shellExecutionEnabled) {
    tools.ai2nao_run_shell = createBashTool(deps.bashTool, {
      defaultTimeoutMs: props.shellExecutionTimeoutMs,
      approvalStore: deps.bashApprovalStore,
      ruleStore: deps.bashPermissionRules,
      permissionMode: props.shellPermissionMode,
      sessionId: options?.sessionId,
    });
  }

  return tools;
}
