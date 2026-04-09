/**
 * Cursor local chat history (read-only). Ported for ai2nao; do not import from `cursor-history/`.
 */
export {
  findWorkspaces,
  listSessions,
  listWorkspaces,
  getSession,
  searchSessions,
  listGlobalSessions,
  getGlobalSession,
  readWorkspaceJson,
  findWorkspaceForSession,
  findWorkspaceByPath,
  getComposerData,
  resolveSessionIdentifiers,
  openDatabase,
  mapBubbleToMessage,
  extractToolCalls,
  extractTokenUsage,
  extractModelInfo,
  extractTimingInfo,
  extractTimestamp,
  fillTimestampGaps,
} from "./storage.js";
export type { ComposerDataResult } from "./storage.js";
export {
  parseChatData,
  getSearchSnippets,
  exportToMarkdown,
  exportToJson,
  extractCodeBlocks,
} from "./parser.js";
export type { CursorChatBundle } from "./parser.js";
export {
  getCursorDataPath,
  getDefaultCursorDataPath,
  expandPath,
  contractPath,
  normalizePath,
  pathsEqual,
  detectPlatform,
} from "./platform.js";
export { SessionNotFoundError } from "./errors.js";
export type {
  Workspace,
  ChatSession,
  ChatSessionSummary,
  Message,
  SearchResult,
  SearchSnippet,
  ListOptions,
  SearchOptions,
  ToolCall,
  TokenUsage,
  SessionUsage,
} from "./types.js";
