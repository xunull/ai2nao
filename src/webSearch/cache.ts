export type WebSearchCacheEntry<T> = {
  value: T;
  expiresAtMs: number;
};

export class WebSearchMemoryCache<T> {
  private readonly entries = new Map<string, WebSearchCacheEntry<T>>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  get(key: string): T | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (hit.expiresAtMs <= this.nowMs()) {
      this.entries.delete(key);
      return null;
    }
    return hit.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.entries.set(key, { value, expiresAtMs: this.nowMs() + ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}
