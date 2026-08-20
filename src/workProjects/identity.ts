import { isAbsolute } from "node:path";
import { canonicalizePath } from "../path/canonical.js";

export type WorkProjectSource = "claude-code" | "codex" | "opencode" | "kimi";

export type WorkProjectIdentityInput = {
  source: WorkProjectSource;
  fallbackId: string;
  decodedWorkspacePath?: string | null;
  cwd?: string | null;
  workspacePath?: string | null;
  workspaceId?: string | null;
};

export type WorkProjectIdentity = {
  key: string;
  path: string;
  confidence: "high" | "low";
};

export function normalizeWorkProjectIdentity(
  input: WorkProjectIdentityInput
): WorkProjectIdentity {
  const candidates = [
    input.decodedWorkspacePath,
    input.cwd,
    input.workspacePath,
    input.workspaceId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed || !isAbsolute(trimmed)) continue;
    const canonical = canonicalizePath(trimmed, { bestEffort: true });
    if (canonical) return { key: canonical, path: canonical, confidence: "high" };
  }

  const fallback = `${input.source}:${input.workspaceId || input.fallbackId}`;
  return {
    key: fallback,
    path: input.workspacePath || input.cwd || fallback,
    confidence: "low",
  };
}
