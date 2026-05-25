import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultBashSandboxConfigPath } from "../config.js";
import {
  checkBashSandboxDependencies,
  isBashSandboxSupportedPlatform,
  resolveBashSandboxPolicy,
  type BashSandboxFilesystemPolicy,
  type BashSandboxMode,
  type BashSandboxNetworkPolicy,
} from "./sandboxRunner.js";

export type BashSandboxConfig = {
  version: 1;
  mode: BashSandboxMode;
  filesystem: BashSandboxFilesystemPolicy;
  network: BashSandboxNetworkPolicy;
};

export type BashSandboxStatus = {
  configPath: string;
  configured: boolean;
  config: BashSandboxConfig;
  effectivePolicy: {
    filesystem: BashSandboxFilesystemPolicy;
    network: BashSandboxNetworkPolicy;
  };
  dependencies: {
    supportedPlatform: boolean;
    ok: boolean;
    warnings: string[];
    errors: string[];
  };
  error: string | null;
};

function configPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.AI2NAO_BASH_SANDBOX_CONFIG ?? "").trim();
  return raw.length > 0 ? resolve(raw) : defaultBashSandboxConfigPath();
}

export function defaultBashSandboxConfig(projectRoot = process.cwd()): BashSandboxConfig {
  const policy = resolveBashSandboxPolicy({
    mode: "off",
    cwd: projectRoot,
    projectRoot,
  });
  return {
    version: 1,
    mode: "off",
    filesystem: policy.filesystem,
    network: policy.network,
  };
}

export function parseBashSandboxConfigJson(
  raw: string,
  projectRoot = process.cwd()
): BashSandboxConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  try {
    return normalizeBashSandboxConfig(parsed, projectRoot);
  } catch {
    return null;
  }
}

export function readBashSandboxConfig(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot = process.cwd()
): { config: BashSandboxConfig; configPath: string; configured: boolean; error: string | null } {
  const configPath = configPathFromEnv(env);
  if (!existsSync(configPath)) {
    return {
      config: defaultBashSandboxConfig(projectRoot),
      configPath,
      configured: false,
      error: null,
    };
  }
  try {
    const config = parseBashSandboxConfigJson(readFileSync(configPath, "utf8"), projectRoot);
    if (!config) {
      return {
        config: defaultBashSandboxConfig(projectRoot),
        configPath,
        configured: true,
        error: "bash sandbox config is not valid JSON or has an invalid shape",
      };
    }
    return { config, configPath, configured: true, error: null };
  } catch (error) {
    return {
      config: defaultBashSandboxConfig(projectRoot),
      configPath,
      configured: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function writeBashSandboxConfig(
  config: BashSandboxConfig,
  env: NodeJS.ProcessEnv = process.env
): string {
  const configPath = configPathFromEnv(env);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

export function getBashSandboxStatus(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot = process.cwd()
): BashSandboxStatus {
  const { config, configPath, configured, error } = readBashSandboxConfig(env, projectRoot);
  const effectivePolicy = resolveBashSandboxPolicy({
    mode: config.mode,
    cwd: projectRoot,
    projectRoot,
    filesystem: config.filesystem,
    network: config.network,
  });
  const dependency = checkBashSandboxDependencies();
  return {
    configPath,
    configured,
    config,
    effectivePolicy,
    dependencies: {
      supportedPlatform: isBashSandboxSupportedPlatform(),
      ok: dependency.errors.length === 0,
      warnings: dependency.warnings,
      errors: dependency.errors,
    },
    error,
  };
}

export function normalizeBashSandboxConfig(
  input: unknown,
  projectRoot = process.cwd()
): BashSandboxConfig {
  const data = record(input, "config must be an object");
  if (data.version !== undefined && data.version !== 1) {
    throw new Error("version must be 1");
  }
  const defaults = defaultBashSandboxConfig(projectRoot);
  const mode = data.mode === undefined ? defaults.mode : parseMode(data.mode);
  return {
    version: 1,
    mode,
    filesystem: normalizeFilesystem(data.filesystem, defaults.filesystem),
    network: normalizeNetwork(data.network, defaults.network),
  };
}

export function serviceSandboxConfig(config: BashSandboxConfig): {
  mode: BashSandboxMode;
  filesystem: BashSandboxFilesystemPolicy;
  network: BashSandboxNetworkPolicy;
} {
  return {
    mode: config.mode,
    filesystem: config.filesystem,
    network: config.network,
  };
}

function normalizeFilesystem(
  input: unknown,
  defaults: BashSandboxFilesystemPolicy
): BashSandboxFilesystemPolicy {
  if (input === undefined) return defaults;
  const data = record(input, "filesystem must be an object");
  return {
    allowWrite: stringList(data.allowWrite, defaults.allowWrite, "filesystem.allowWrite"),
    denyWrite: stringList(data.denyWrite, defaults.denyWrite, "filesystem.denyWrite"),
    denyRead: stringList(data.denyRead, defaults.denyRead, "filesystem.denyRead"),
    allowRead: stringList(data.allowRead, defaults.allowRead, "filesystem.allowRead"),
  };
}

function normalizeNetwork(input: unknown, defaults: BashSandboxNetworkPolicy): BashSandboxNetworkPolicy {
  if (input === undefined) return defaults;
  const data = record(input, "network must be an object");
  return {
    allowedDomains: stringList(data.allowedDomains, defaults.allowedDomains, "network.allowedDomains"),
    deniedDomains: stringList(data.deniedDomains, defaults.deniedDomains, "network.deniedDomains"),
  };
}

function parseMode(value: unknown): BashSandboxMode {
  if (value === "off" || value === "best-effort" || value === "required") return value;
  throw new Error("mode must be off, best-effort, or required");
}

function stringList(value: unknown, fallback: string[], field: string): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return [...new Set(value.map((item) => {
    if (typeof item !== "string") throw new Error(`${field} must contain only strings`);
    return item.trim();
  }).filter(Boolean))];
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}
