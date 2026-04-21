import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultGithubConfigPath } from "../config.js";

/**
 * On-disk shape of `~/.ai2nao/github.json`. Only `token` is required; the
 * optional fields are reserved for future knobs (self-hosted GHES base URL,
 * override username, etc.) without bumping the JSON version.
 */
export type GithubConfig = {
  token: string;
  username?: string;
  apiBase?: string;
};

/**
 * Snapshot of token-loading state for `/api/github/sync-state` and CLI banners.
 * Never contains the token itself — only coarse booleans and the source hint.
 */
export type GithubTokenStatus = {
  configured: boolean;
  source: "env" | "file" | null;
  configPath: string;
  envVar: "GITHUB_TOKEN";
  /** True when the file exists but its mode allows group/other read. */
  insecureFilePermissions: boolean;
};

const ENV_VAR = "GITHUB_TOKEN";

function configPathFromEnv(): string {
  const raw = (process.env.AI2NAO_GITHUB_CONFIG ?? "").trim();
  return raw.length > 0 ? resolve(raw) : defaultGithubConfigPath();
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function parseGithubConfigJson(raw: string): GithubConfig | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const token = data.token;
  if (typeof token !== "string" || token.trim().length === 0) return null;
  const out: GithubConfig = { token: token.trim() };
  if (typeof data.username === "string" && data.username.trim().length > 0) {
    out.username = data.username.trim();
  }
  if (typeof data.apiBase === "string" && data.apiBase.trim().length > 0) {
    out.apiBase = data.apiBase.trim();
  }
  return out;
}

/**
 * Check if a file's mode allows any group/other read bits. Best-effort on
 * Windows (fs mode bits there are mostly synthetic) — we only warn, never throw.
 */
function isGroupOrOtherReadable(path: string): boolean {
  try {
    const st = statSync(path);
    return (st.mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

/**
 * Load a GitHub token, preferring `GITHUB_TOKEN` env var over the on-disk file.
 * Returns `null` when nothing is configured; callers should surface a user-
 * facing error in that case rather than silently no-op.
 *
 * As a side effect, when the config file exists with overly broad permissions
 * we log a warning to stderr — we do NOT auto-chmod on read, because that
 * would mask badly-shared machines. We only auto-chmod on *write*
 * (see `writeGithubConfig`).
 */
export function loadGithubToken(): {
  token: string;
  source: "env" | "file";
  config: GithubConfig;
} | null {
  const envToken = (process.env[ENV_VAR] ?? "").trim();
  if (envToken.length > 0) {
    return {
      token: envToken,
      source: "env",
      config: { token: envToken },
    };
  }
  const path = configPathFromEnv();
  if (!existsSync(path)) return null;
  if (isGroupOrOtherReadable(path)) {
    console.error(
      `warning: ${path} is group/other-readable; run \`chmod 0600 ${path}\` to protect your GitHub token.`
    );
  }
  try {
    const raw = readFileSync(path, "utf8");
    const cfg = parseGithubConfigJson(raw);
    if (!cfg) return null;
    return { token: cfg.token, source: "file", config: cfg };
  } catch {
    return null;
  }
}

/**
 * Write a new token file. Creates `~/.ai2nao/` if missing and forces 0600
 * immediately after write so the token never lingers world-readable even
 * on systems with a loose umask.
 */
export function writeGithubConfig(cfg: GithubConfig, explicitPath?: string): string {
  const path = explicitPath ? resolve(explicitPath) : configPathFromEnv();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8" });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* chmod is best-effort on Windows; file is still written */
  }
  return path;
}

export function githubTokenStatus(): GithubTokenStatus {
  const configPath = configPathFromEnv();
  const envToken = (process.env[ENV_VAR] ?? "").trim();
  if (envToken.length > 0) {
    return {
      configured: true,
      source: "env",
      configPath,
      envVar: ENV_VAR,
      insecureFilePermissions: false,
    };
  }
  const fileExists = existsSync(configPath);
  if (!fileExists) {
    return {
      configured: false,
      source: null,
      configPath,
      envVar: ENV_VAR,
      insecureFilePermissions: false,
    };
  }
  const insecure = isGroupOrOtherReadable(configPath);
  try {
    const cfg = parseGithubConfigJson(readFileSync(configPath, "utf8"));
    return {
      configured: cfg !== null,
      source: cfg !== null ? "file" : null,
      configPath,
      envVar: ENV_VAR,
      insecureFilePermissions: insecure,
    };
  } catch {
    return {
      configured: false,
      source: null,
      configPath,
      envVar: ENV_VAR,
      insecureFilePermissions: insecure,
    };
  }
}

export { configPathFromEnv as _githubConfigPathForTest };
