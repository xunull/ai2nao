/** Default relative manifest paths to index (repo root–relative). */
export const DEFAULT_MANIFEST_RELS = [
  "README.md",
  "README",
  "readme.md",
  "package.json",
  "go.mod",
  "pyproject.toml",
  "Cargo.toml",
  "Gemfile",
] as const;

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

/** Dedicated SQLite for RAG chunks + FTS5 (separate from main index.db). */
export function defaultRagDbPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return ".ai2nao/rag.db";
  return `${home}/.ai2nao/rag.db`;
}
