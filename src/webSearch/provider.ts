import type { WebSearchProviderResponse } from "./types.js";

export type WebSearchProvider = {
  readonly provider: "brave";
  search(args: {
    query: string;
    count: number;
    signal?: AbortSignal;
  }): Promise<WebSearchProviderResponse>;
};
