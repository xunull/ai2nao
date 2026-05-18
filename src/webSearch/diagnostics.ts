import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { WebSearchDiagnosticEvent, WebSearchProviderName } from "./types.js";

export type WebSearchDiagnostics = {
  record(event: Omit<WebSearchDiagnosticEvent, "id" | "ts">): WebSearchDiagnosticEvent;
  recent(limit?: number): WebSearchDiagnosticEvent[];
  hashQuery(query: string): string;
};

export function createWebSearchDiagnostics(limit = 30): WebSearchDiagnostics {
  const salt = randomBytes(32);
  const events: WebSearchDiagnosticEvent[] = [];
  return {
    record(event) {
      const item: WebSearchDiagnosticEvent = {
        id: randomUUID(),
        ts: new Date().toISOString(),
        ...event,
      };
      events.unshift(item);
      if (events.length > limit) events.length = limit;
      return item;
    },
    recent(n = limit) {
      return events.slice(0, Math.max(0, n));
    },
    hashQuery(query) {
      return createHmac("sha256", salt).update(query).digest("hex").slice(0, 16);
    },
  };
}

export function statusFromErrorCode(code: string): WebSearchDiagnosticEvent["status"] {
  if (code === "provider_auth_error") return "auth_error";
  if (code === "provider_rate_limited") return "rate_limited";
  if (code === "provider_timeout") return "timeout";
  if (code === "provider_parse_error") return "parse_error";
  if (code === "sensitive_query_blocked") return "sensitive_blocked";
  if (code === "tool_unavailable") return "disabled";
  if (code === "tool_input_invalid") return "invalid_input";
  return "provider_error";
}

export function providerNameForDiagnostics(): WebSearchProviderName {
  return "brave";
}
