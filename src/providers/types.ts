/**
 * Pluggable "external AI provider usage" source.
 *
 * Each AI platform (MiniMax, future ones) implements ProviderUsageSource and
 * registers in the registry. The scheduler iterates ENABLED providers and calls
 * sync(); the result is a current usage SNAPSHOT (these providers expose a
 * remaining-quota snapshot, not per-day history). Adding a provider = one module
 * + one registry entry; the management page / sync task / display pick it up
 * automatically.
 */

/** Config passed to a provider's sync (the API key the user entered). */
export type ProviderSyncConfig = {
  apiKey: string;
};

/**
 * One displayable usage line. MiniMax returns per-model-group quota, so each
 * item is a model group (general / video / …). `remainingPercent` + `resetAt`
 * are the primary, interpretable signal (a window remaining %, not a cumulative
 * count — MiniMax's *_count fields are unreliable). `detail` holds the rest
 * (e.g. the weekly window) for the UI to render.
 */
export type ProviderSnapshotItem = {
  key: string;
  label: string;
  remainingPercent: number | null;
  resetAt: string | null;
  detail: Record<string, unknown>;
};

export type ProviderSnapshot = {
  items: ProviderSnapshotItem[];
  /** Raw API response, kept verbatim for debugging / forward-compat. */
  raw: unknown;
};

export type ProviderUsageSource = {
  id: string;
  label: string;
  /** Throws on transport/auth error; returns a snapshot otherwise. */
  sync(config: ProviderSyncConfig): Promise<ProviderSnapshot>;
};
