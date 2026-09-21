import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultGithubConfigPath } from "../config.js";
import { getCredentialRaw, getSettingRaw } from "../settings/store.js";

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
  source: "env" | "db" | "file" | null;
  configPath: string;
  envVar: "GITHUB_TOKEN";
  /** True when the LEGACY file exists and its mode allows group/other read.
   * Always false once the token lives in config.db (which is created 0600). */
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
  source: "env" | "db" | "file";
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
  const stored = getCredentialRaw("github");
  if (stored) {
    const cfg = parseGithubConfigJson(stored);
    if (cfg) return { token: cfg.token, source: "db", config: cfg };
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
 * Write a new token file ATOMICALLY: write a 0600 temp file in the same dir,
 * fsync it, then rename over the target (atomic on POSIX). On failure the old
 * file is left intact — a crash mid-write can never truncate an existing token,
 * and the token never lingers world-readable even under a loose umask.
 */
export function writeGithubConfig(cfg: GithubConfig, explicitPath?: string): string {
  const path = explicitPath ? resolve(explicitPath) : configPathFromEnv();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const body = JSON.stringify(cfg, null, 2) + "\n";
  try {
    const fd = openSync(tmp, "w", 0o600); // created 0600 from the start
    try {
      writeFileSync(fd, body, { encoding: "utf8" });
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path); // atomic replace; old file survives until this point
    try {
      chmodSync(path, 0o600); // belt-and-suspenders (rename may carry target's old mode)
    } catch {
      /* chmod is best-effort on Windows; file is still written */
    }
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* temp cleanup best-effort */
    }
    throw e;
  }
  return path;
}

/** Delete the on-disk token file (best-effort; no error if absent). Does NOT
 * affect a `GITHUB_TOKEN` env var, which still takes precedence after deletion. */
export function deleteGithubConfig(explicitPath?: string): void {
  const path = explicitPath ? resolve(explicitPath) : configPathFromEnv();
  rmSync(path, { force: true });
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
  const stored = getCredentialRaw("github");
  if (stored && parseGithubConfigJson(stored)) {
    return {
      configured: true,
      source: "db",
      configPath,
      envVar: ENV_VAR,
      insecureFilePermissions: false, // config.db is created 0600
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

/**
 * 开源雷达的「当前工作目录」。
 *
 * 洞察重算要靠 git 分支、提交和 TODO 文档回答「你现在在做什么」,而那些只能从一个
 * 具体目录里扫出来(`radarInsights/currentWork.ts` 用 execGitSync)。原来它用的是
 * **进程 cwd**,而打包的桌面版守护进程 cwd 是 `/` —— 扫出来必然是空,于是那批
 * 「现在可能用得上」的推荐实际上退化成了静态排序,界面上还看不出来。
 *
 * 所以把它做成一个显式设置。留空时**不回退到进程 cwd**:回退保持的是一个已知无效的
 * 行为,还要白白 fork 几个 git 进程去确认。留空就跳过当前工作扫描,并在结果里说明。
 */
export type GithubRadarSetting = { cwd: string };

export function parseGithubRadarSettingJson(raw: string): GithubRadarSetting | null {
  try {
    const data = JSON.parse(raw) as { cwd?: unknown };
    const cwd = typeof data.cwd === "string" ? data.cwd.trim() : "";
    return { cwd };
  } catch {
    return null;
  }
}

/** 设置里的目录;没配或空串时返回 null(调用方据此跳过当前工作扫描)。 */
export function readGithubRadarCwd(): string | null {
  const stored = getSettingRaw("github-radar");
  if (!stored) return null;
  const parsed = parseGithubRadarSettingJson(stored);
  const cwd = parsed?.cwd ?? "";
  return cwd.length > 0 ? cwd : null;
}

export { configPathFromEnv as _githubConfigPathForTest };
