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
];

export function listProviderSources(): ProviderUsageSource[] {
  return PROVIDER_SOURCES;
}

export function getProviderSource(id: string): ProviderUsageSource | null {
  return PROVIDER_SOURCES.find((p) => p.id === id) ?? null;
}
