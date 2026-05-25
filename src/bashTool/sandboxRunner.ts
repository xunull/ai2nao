import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  SandboxManager,
  type SandboxDependencyCheck,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

export type BashSandboxMode = "off" | "best-effort" | "required";

export type BashSandboxBackend = "none" | "anthropic-sandbox-runtime" | "test";

export type BashSandboxNetworkPolicy = {
  allowedDomains: string[];
  deniedDomains: string[];
};

export type BashSandboxFilesystemPolicy = {
  allowWrite: string[];
  denyWrite: string[];
  denyRead: string[];
  allowRead: string[];
};

export type BashSandboxPolicy = {
  mode: BashSandboxMode;
  cwd: string;
  projectRoot: string;
  filesystem?: Partial<BashSandboxFilesystemPolicy>;
  network?: Partial<BashSandboxNetworkPolicy>;
};

export type BashSandboxDebug = {
  mode: BashSandboxMode;
  backend: BashSandboxBackend;
  applied: boolean;
  filesystem: BashSandboxFilesystemPolicy;
  network: BashSandboxNetworkPolicy;
  dependencyWarnings: string[];
  dependencyErrors: string[];
  unavailableReason?: string;
};

export type BashSandboxWrapResult =
  | {
      ok: true;
      command: string;
      debug: BashSandboxDebug;
    }
  | {
      ok: false;
      reason: string;
      debug: BashSandboxDebug;
    };

export type BashSandboxRunner = {
  wrap(command: string, policy: BashSandboxPolicy, signal?: AbortSignal): Promise<BashSandboxWrapResult>;
  annotateStderrWithSandboxFailures?(command: string, stderr: string): string;
  cleanupAfterCommand?(): void;
};

export type ResolvedBashSandboxPolicy = {
  filesystem: BashSandboxFilesystemPolicy;
  network: BashSandboxNetworkPolicy;
};

const SENSITIVE_READ_PATHS = [
  ".env",
  ".env.local",
  ".env.production",
  "~/.ssh",
  "~/.aws",
  "~/.gcloud",
  "~/.kube",
  "~/.docker",
  "~/Library/Application Support/Google/Chrome",
  "~/Library/Application Support/Chromium",
];

const SENSITIVE_WRITE_PATHS = [
  ".env",
  ".env.local",
  ".env.production",
  ".git/config",
  ".git/hooks",
  ".ai2nao",
];

export function createNoopBashSandboxRunner(): BashSandboxRunner {
  return {
    async wrap(command, policy) {
      return {
        ok: true,
        command,
        debug: buildSandboxDebug(policy, "none", false),
      };
    },
  };
}

export function createStrictWorkspaceBashSandboxPolicy(
  projectRoot = process.cwd()
): ResolvedBashSandboxPolicy {
  const root = resolve(projectRoot);
  return {
    filesystem: {
      allowWrite: [root],
      denyWrite: SENSITIVE_WRITE_PATHS.map((path) => resolve(root, path)),
      denyRead: uniquePaths([homedir(), ...expandSensitiveReadPaths(root)]),
      allowRead: [root],
    },
    network: {
      allowedDomains: [],
      deniedDomains: [],
    },
  };
}

export function createAnthropicSandboxRuntimeRunner(): BashSandboxRunner {
  let initialized = false;
  const baseConfig = buildRuntimeConfig({
    mode: "best-effort",
    cwd: process.cwd(),
    projectRoot: process.cwd(),
  });

  return {
    async wrap(command, policy, signal) {
      const config = buildRuntimeConfig(policy);
      const dependency = checkBashSandboxDependencies();
      const unavailableReason = unavailableSandboxReason(dependency);
      const unavailableDebug = buildSandboxDebug(
        policy,
        "anthropic-sandbox-runtime",
        false,
        dependency,
        unavailableReason
      );

      if (policy.mode === "off") {
        return {
          ok: true,
          command,
          debug: buildSandboxDebug(policy, "none", false),
        };
      }

      if (unavailableReason) {
        if (policy.mode === "required") {
          return { ok: false, reason: unavailableReason, debug: unavailableDebug };
        }
        return { ok: true, command, debug: unavailableDebug };
      }

      try {
        if (needsNetworkProxy(config) && !initialized) {
          await SandboxManager.initialize(baseConfig);
          initialized = true;
        }
        const wrapped = await SandboxManager.wrapWithSandbox(command, "bash", config, signal);
        return {
          ok: true,
          command: wrapped,
          debug: buildSandboxDebug(policy, "anthropic-sandbox-runtime", true, dependency),
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const debug = buildSandboxDebug(
          policy,
          "anthropic-sandbox-runtime",
          false,
          dependency,
          reason
        );
        if (policy.mode === "required") {
          return { ok: false, reason, debug };
        }
        return { ok: true, command, debug };
      }
    },
    annotateStderrWithSandboxFailures(command, stderr) {
      return SandboxManager.annotateStderrWithSandboxFailures(command, stderr);
    },
    cleanupAfterCommand() {
      SandboxManager.cleanupAfterCommand();
    },
  };
}

function needsNetworkProxy(config: SandboxRuntimeConfig): boolean {
  return config.network.allowedDomains.length > 0;
}

function buildRuntimeConfig(policy: BashSandboxPolicy): SandboxRuntimeConfig {
  const { filesystem, network } = resolveBashSandboxPolicy(policy);
  return {
    network: {
      allowedDomains: network.allowedDomains,
      deniedDomains: network.deniedDomains,
    },
    filesystem: {
      denyRead: filesystem.denyRead,
      allowRead: filesystem.allowRead,
      allowWrite: filesystem.allowWrite,
      denyWrite: filesystem.denyWrite,
    },
  };
}

export function resolveBashSandboxPolicy(policy: BashSandboxPolicy): ResolvedBashSandboxPolicy {
  return {
    filesystem: buildFilesystemPolicy(policy),
    network: buildNetworkPolicy(policy),
  };
}

function buildSandboxDebug(
  policy: BashSandboxPolicy,
  backend: BashSandboxBackend,
  applied: boolean,
  dependency?: SandboxDependencyCheck,
  unavailableReason?: string
): BashSandboxDebug {
  return {
    mode: policy.mode,
    backend,
    applied,
    filesystem: buildFilesystemPolicy(policy),
    network: buildNetworkPolicy(policy),
    dependencyWarnings: dependency?.warnings ?? [],
    dependencyErrors: dependency?.errors ?? [],
    unavailableReason,
  };
}

function buildFilesystemPolicy(policy: BashSandboxPolicy): BashSandboxFilesystemPolicy {
  const allowWrite = policy.filesystem?.allowWrite ?? [policy.cwd, tmpdir()];
  const denyWrite = policy.filesystem?.denyWrite ?? SENSITIVE_WRITE_PATHS.map((path) => resolve(policy.cwd, path));
  const denyRead = policy.filesystem?.denyRead ?? expandSensitiveReadPaths(policy.cwd);
  const allowRead = policy.filesystem?.allowRead ?? [policy.cwd, policy.projectRoot];
  return {
    allowWrite: uniquePaths(allowWrite),
    denyWrite: uniquePaths(denyWrite),
    denyRead: uniquePaths(denyRead),
    allowRead: uniquePaths(allowRead),
  };
}

function buildNetworkPolicy(policy: BashSandboxPolicy): BashSandboxNetworkPolicy {
  return {
    allowedDomains: [...(policy.network?.allowedDomains ?? [])],
    deniedDomains: [...(policy.network?.deniedDomains ?? [])],
  };
}

function expandSensitiveReadPaths(cwd: string): string[] {
  const home = homedir();
  return SENSITIVE_READ_PATHS.map((path) => {
    if (path.startsWith("~/")) return resolve(home, path.slice(2));
    return resolve(cwd, path);
  });
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
}

export function checkBashSandboxDependencies(): SandboxDependencyCheck {
  if (!SandboxManager.isSupportedPlatform()) {
    return {
      warnings: [],
      errors: [`unsupported platform: ${process.platform}`],
    };
  }
  return SandboxManager.checkDependencies();
}

export function isBashSandboxSupportedPlatform(): boolean {
  return SandboxManager.isSupportedPlatform();
}

function unavailableSandboxReason(dependency: SandboxDependencyCheck): string | undefined {
  if (dependency.errors.length === 0) return undefined;
  return `sandbox unavailable: ${dependency.errors.join(", ")}`;
}
