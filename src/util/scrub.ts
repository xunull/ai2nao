/**
 * Strip real home paths from any text that might leave the machine or land in a
 * public artifact (LLM prompts, cluster labels, outbound webhook payloads).
 *
 * ai2nao is a public repo with a gitleaks pre-commit hook, and the push layer
 * sends narratives containing repo names / commit subjects to Feishu — neither
 * should ever carry `/Users/<realname>/`.
 */
export function scrubPaths(s: string): string {
  return (s ?? "").replace(/\/(Users|home)\/[^/\s]+/g, "/$1/*");
}
