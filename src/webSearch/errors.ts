export class WebSearchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly recoverable = true
  ) {
    super(message);
  }
}

export class SearchProviderAuthError extends WebSearchError {
  constructor(message = "Search provider authentication failed") {
    super("provider_auth_error", message, true);
  }
}

export class SearchProviderRateLimitError extends WebSearchError {
  constructor(message = "Search provider rate limited the request") {
    super("provider_rate_limited", message, true);
  }
}

export class SearchProviderTimeoutError extends WebSearchError {
  constructor(message = "Search provider request timed out") {
    super("provider_timeout", message, true);
  }
}

export class SearchProviderParseError extends WebSearchError {
  constructor(message = "Search provider returned an invalid response") {
    super("provider_parse_error", message, true);
  }
}

export class SensitiveQueryBlocked extends WebSearchError {
  constructor(message = "This query may contain local or sensitive data; rewrite it as public search terms.") {
    super("sensitive_query_blocked", message, true);
  }
}

export class ToolUnavailableError extends WebSearchError {
  constructor(message = "Web Search is unavailable or disabled") {
    super("tool_unavailable", message, true);
  }
}

export class ToolInputValidationError extends WebSearchError {
  constructor(message = "Invalid web search input") {
    super("tool_input_invalid", message, true);
  }
}

export function isWebSearchError(error: unknown): error is WebSearchError {
  return error instanceof WebSearchError;
}
