import { SensitiveQueryBlocked, ToolInputValidationError } from "./errors.js";

const MAX_QUERY_CHARS = 500;

const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\s)(~\/|\/Users\/|\/private\/|\/var\/|\/etc\/|[A-Za-z]:\\)/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(sk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/i,
  /\b[A-Fa-f0-9]{32,}\b/,
  /\b[A-Za-z0-9_-]{40,}\b/,
];

export function normalizeCacheQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

export function sanitizeWebSearchQuery(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ToolInputValidationError("query must be a string");
  }
  const query = raw.trim().replace(/\s+/g, " ");
  if (!query) {
    throw new ToolInputValidationError("query is required");
  }
  if (query.length > MAX_QUERY_CHARS) {
    throw new ToolInputValidationError(`query must be ${MAX_QUERY_CHARS} characters or less`);
  }
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(query))) {
    throw new SensitiveQueryBlocked();
  }
  return query;
}

export function clampResultCount(raw: unknown, defaultResults: number, maxResults: number): number {
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return defaultResults;
  return Math.min(maxResults, Math.max(1, Math.trunc(n)));
}
