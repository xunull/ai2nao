import type { RagConfigV1 } from "./types.js";

/** When user passes only `--root` without rag.json. */
export function minimalRagConfig(roots: string[]): RagConfigV1 {
  return {
    version: 1,
    corpusRoots: roots,
    includeExtensions: [".md", ".mdx", ".txt"],
    maxFileBytes: 8 * 1024 * 1024,
    respectDefaultExcludes: true,
  };
}
