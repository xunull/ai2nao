import { createClaudeSubscriptionProvider } from "./claudeSubscription.js";
import { createCodexSubscriptionProvider } from "./codexSubscription.js";
import { createKimiProvider } from "./kimi.js";
import { createMinimaxProvider } from "./minimax.js";
import type { ProviderUsageSource } from "./types.js";

/**
 * Registered provider sources. Add a provider = add one entry here (plus its
 * module). The management page, sync task, and display all iterate this list,
 * so a new provider surfaces everywhere automatically.
 */
export const PROVIDER_SOURCES: ProviderUsageSource[] = [
  createMinimaxProvider(),
  createKimiProvider(),
  // Subscription-quota sources: no key to configure, they read this machine's
  // Claude Code / Codex login (see `requiresApiKey: false`).
  createClaudeSubscriptionProvider(),
  createCodexSubscriptionProvider(),
];

export function listProviderSources(): ProviderUsageSource[] {
  return PROVIDER_SOURCES;
}

export function getProviderSource(id: string): ProviderUsageSource | null {
  return PROVIDER_SOURCES.find((p) => p.id === id) ?? null;
}
