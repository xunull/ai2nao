import type {
  ChatSession,
  ChatSessionSummary,
  SearchResult,
  Workspace,
} from "./types.js";

export function workspaceToJson(w: Workspace) {
  return {
    id: w.id,
    path: w.path,
    dbPath: w.dbPath,
    sessionCount: w.sessionCount,
  };
}

export function sessionSummaryToJson(s: ChatSessionSummary) {
  return {
    id: s.id,
    index: s.index,
    title: s.title,
    createdAt: s.createdAt.toISOString(),
    lastUpdatedAt: s.lastUpdatedAt.toISOString(),
    messageCount: s.messageCount,
    workspaceId: s.workspaceId,
    workspacePath: s.workspacePath,
    preview: s.preview,
  };
}

export function messageToJson(m: ChatSession["messages"][number]) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    timestamp: m.timestamp.toISOString(),
    codeBlocks: m.codeBlocks,
    toolCalls: m.toolCalls,
    thinking: m.thinking,
    tokenUsage: m.tokenUsage,
    model: m.model,
    durationMs: m.durationMs,
    metadata: m.metadata,
  };
}

export function sessionToJson(s: ChatSession) {
  return {
    id: s.id,
    index: s.index,
    title: s.title,
    createdAt: s.createdAt.toISOString(),
    lastUpdatedAt: s.lastUpdatedAt.toISOString(),
    messageCount: s.messageCount,
    workspaceId: s.workspaceId,
    workspacePath: s.workspacePath,
    source: s.source,
    usage: s.usage,
    activeBranchBubbleIds: s.activeBranchBubbleIds,
    messages: s.messages.map(messageToJson),
  };
}

export function searchResultToJson(r: SearchResult) {
  return {
    sessionId: r.sessionId,
    index: r.index,
    workspacePath: r.workspacePath,
    createdAt: r.createdAt.toISOString(),
    matchCount: r.matchCount,
    snippets: r.snippets,
  };
}
