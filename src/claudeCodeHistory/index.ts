/**
 * Claude Code local transcript reader (read-only JSONL under ~/.claude/projects).
 */
export {
  CLAUDE_PROJECTS_ENV,
  defaultClaudeProjectsRoot,
  resolveClaudeProjectsRoot,
} from "./paths.js";
export {
  assertPathInsideRoot,
  isSessionJsonlName,
  listProjects,
  listSessionJsonlFiles,
} from "./discover.js";
export type { ClaudeProjectRow, ClaudeSessionFileRow } from "./discover.js";
export { parseJsonlText } from "./parseJsonl.js";
export type {
  JsonlLineError,
  JsonlLineOk,
  ParseJsonlResult,
} from "./parseJsonl.js";
export { buildClaudeSession } from "./normalize.js";
export type { BuiltClaudeSession } from "./normalize.js";
export {
  ClaudeTranscriptTooLargeError,
  listSessionSummaries,
  loadSessionDetail,
} from "./load.js";
export { MAX_JSONL_BYTES, MAX_JSONL_LINES } from "./constants.js";
export {
  decodeClaudeProjectDirName,
  decodeProjectSlugToPath,
  directoryExistsSync,
  hyphenBoundaryPrefixLengths,
  stripLeadingProjectsDash,
} from "./decodeProjectSlug.js";
export type { DecodeProjectSlugResult } from "./decodeProjectSlug.js";
