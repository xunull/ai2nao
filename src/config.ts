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
