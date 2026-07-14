/** Default relative manifest paths to index (repo root–relative). */
export const DEFAULT_MANIFEST_RELS = [
  "README.md",
  "README",
  "readme.md",
  "TODOS.md",
  "package.json",
  "go.mod",
  "pyproject.toml",
  "Cargo.toml",
  "Gemfile",
] as const;

/** Bounded project context policy shared by scan and GitHub radar. */
export const DEFAULT_PROJECT_CONTEXT = {
  fixedManifestRels: DEFAULT_MANIFEST_RELS,
  docsRootRel: "docs",
  maxDocsPerRepo: 100,
  maxDocBytes: 64 * 1024,
  maxRadarProjects: 80,
  maxRadarSources: 500,
  maxRadarSourceBytes: 64 * 1024,
} as const;

/** Directory name segments that skip subtree walk (beyond .git internals). */
export const DEFAULT_EXCLUDE_DIR_NAMES = new Set([
  "node_modules",
  ".npm",
  "vendor",
  "target",
  "dist",
  "build",
  ".next",
  ".nuxt",
]);

export function defaultDbPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return ".ai2nao/index.db";
  return `${home}/.ai2nao/index.db`;
}

export function defaultDailySummaryDbPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return ".ai2nao/daily-summary.db";
  return `${home}/.ai2nao/daily-summary.db`;
}

/** Global ai2nao JSON config (`~/.ai2nao/config.json`). */
export function defaultAi2naoConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return ".ai2nao/config.json";
  return `${home}/.ai2nao/config.json`;
}

/** JSON config for the optional `/api/llm-chat` UI (OpenAI-compatible endpoints). */
export function defaultLlmChatConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return ".ai2nao/llm-chat.json";
  return `${home}/.ai2nao/llm-chat.json`;
}

/** JSON config for the GitHub personal mirror (token + optional settings). */
export function defaultGithubConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return ".ai2nao/github.json";
  return `${home}/.ai2nao/github.json`;
}

/** JSON config for RAG corpus roots and optional embeddings (`~/.ai2nao/rag.json`). */
export function defaultRagConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return ".ai2nao/rag.json";
  return `${home}/.ai2nao/rag.json`;
}

/** JSON config for AI chat web search (`~/.ai2nao/web-search.json`). */
export function defaultWebSearchConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return ".ai2nao/web-search.json";
  return `${home}/.ai2nao/web-search.json`;
}

/** JSON config for Bash tool OS sandboxing (`~/.ai2nao/bash-sandbox.json`). */
export function defaultBashSandboxConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return ".ai2nao/bash-sandbox.json";
  return `${home}/.ai2nao/bash-sandbox.json`;
}

/** Dedicated SQLite for RAG chunks + FTS5 (separate from main index.db). */
export function defaultRagDbPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return ".ai2nao/rag.db";
  return `${home}/.ai2nao/rag.db`;
}

/**
 * Credentials DB (`~/.ai2nao/config.db`, 0600).
 *
 * Deliberately NOT index.db: that one is hundreds of MB of scanned history, so
 * you can't exclude it from Time Machine / Dropbox without losing your data.
 * A few-KB config.db can be excluded on its own. (0600 only stops other Unix
 * users on this machine — backup daemons run as you.)
 */
export function defaultConfigDbPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return ".ai2nao/config.db";
  return `${home}/.ai2nao/config.db`;
}

/** Local LanceDB directory for optional RAG vector recall. */
export function defaultRagVectorDbPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return ".ai2nao/rag-lance";
  return `${home}/.ai2nao/rag-lance`;
}
