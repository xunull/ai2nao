export const DOMAIN_RULE_VERSION = 1;

export type ChromeHistoryUrlKind =
  | "web"
  | "localhost"
  | "chrome"
  | "extension"
  | "file"
  | "invalid";

export type ChromeHistoryUrlIdentity = {
  urlKind: ChromeHistoryUrlKind;
  scheme: string | null;
  host: string | null;
  domain: string | null;
  origin: string | null;
};

function stripTrailingDot(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

function normalizeHost(host: string): string {
  return stripTrailingDot(host.trim().toLowerCase());
}

function foldSingleWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

function isLocalhost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function chromeHistoryUrlIdentity(url: string): ChromeHistoryUrlIdentity {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      urlKind: "invalid",
      scheme: null,
      host: null,
      domain: null,
      origin: null,
    };
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase() || null;
  const rawHost = parsed.hostname ? normalizeHost(parsed.hostname) : null;

  if (scheme === "http" || scheme === "https") {
    if (!rawHost) {
      return { urlKind: "invalid", scheme, host: null, domain: null, origin: null };
    }
    if (isLocalhost(rawHost)) {
      return {
        urlKind: "localhost",
        scheme,
        host: rawHost,
        domain: "localhost",
        origin: parsed.origin,
      };
    }
    return {
      urlKind: "web",
      scheme,
      host: rawHost,
      domain: foldSingleWww(rawHost),
      origin: parsed.origin,
    };
  }

  if (scheme === "chrome") {
    return {
      urlKind: "chrome",
      scheme,
      host: rawHost,
      domain: "chrome",
      origin: "chrome://",
    };
  }

  if (scheme === "chrome-extension") {
    return {
      urlKind: "extension",
      scheme,
      host: rawHost,
      domain: rawHost,
      origin: rawHost ? `chrome-extension://${rawHost}` : null,
    };
  }

  if (scheme === "file") {
    return {
      urlKind: "file",
      scheme,
      host: rawHost,
      domain: null,
      origin: "file://",
    };
  }

  return {
    urlKind: "invalid",
    scheme,
    host: rawHost,
    domain: rawHost,
    origin: parsed.origin === "null" ? null : parsed.origin,
  };
}
