import { spawn } from "child_process";
import { constants as fsConstants } from "fs";
import { access, realpath } from "fs/promises";
import { isAbsolute, resolve, relative } from "path";
import type { BashApprovalStore } from "./approvalStore.js";
import { checkBashPermission } from "./permissions.js";
import {
  createAnthropicSandboxRuntimeRunner,
  createNoopBashSandboxRunner,
  type BashSandboxDebug,
  type BashSandboxFilesystemPolicy,
  type BashSandboxMode,
  type BashSandboxNetworkPolicy,
  type BashSandboxRunner,
} from "./sandboxRunner.js";
import {
  suggestBashPermissionRules,
  type BashPermissionRuleStore,
} from "./rules.js";
import type {
  BashPermissionBehavior,
  BashPermissionDebug,
  BashPermissionMode,
  BashPermissionRuleMatch,
  BashToolLimits,
  BashToolRequest,
  BashToolResult,
  BashToolRisk,
} from "./types.js";

const DEFAULT_LIMITS: BashToolLimits = {
  timeoutMs: 10_000,
  maxTimeoutMs: 30_000,
  maxCommandChars: 4_000,
  maxOutputChars: 30_000,
};

const SAFE_ENV_ALLOWLIST = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "TERM",
  "TMPDIR",
  "USER",
  "SHELL",
]);

export type BashToolService = {
  run(
    request: BashToolRequest,
    options?: {
      signal?: AbortSignal;
      approval?: {
        store: BashApprovalStore;
        sessionId: string;
        ttlMs?: number;
      };
      permissionMode?: BashPermissionMode;
    }
  ): Promise<BashToolResult>;
};

export function createBashToolService(options?: {
  projectRoot?: string;
  limits?: Partial<BashToolLimits>;
  ruleStore?: BashPermissionRuleStore;
  sandbox?: {
    mode?: BashSandboxMode;
    filesystem?: Partial<BashSandboxFilesystemPolicy>;
    network?: Partial<BashSandboxNetworkPolicy>;
    runner?: BashSandboxRunner;
  };
}): BashToolService {
  const projectRoot = resolve(options?.projectRoot ?? process.cwd());
  const limits = { ...DEFAULT_LIMITS, ...options?.limits };
  const sandboxMode = options?.sandbox?.mode ?? "off";
  const sandboxFilesystem = options?.sandbox?.filesystem;
  const sandboxNetwork = options?.sandbox?.network;
  const sandboxRunner = options?.sandbox?.runner
    ?? (sandboxMode === "off" ? createNoopBashSandboxRunner() : createAnthropicSandboxRuntimeRunner());

  return {
    run: (request, runOptions) =>
      runBashCommand(request, {
        projectRoot,
        limits,
        ruleStore: options?.ruleStore,
        sandboxMode,
        sandboxFilesystem,
        sandboxNetwork,
        sandboxRunner,
        signal: runOptions?.signal,
        approval: runOptions?.approval,
        permissionMode: runOptions?.permissionMode ?? "default",
      }),
  };
}

async function runBashCommand(
  request: BashToolRequest,
  options: {
    projectRoot: string;
    limits: BashToolLimits;
    ruleStore?: BashPermissionRuleStore;
    sandboxMode: BashSandboxMode;
    sandboxFilesystem?: Partial<BashSandboxFilesystemPolicy>;
    sandboxNetwork?: Partial<BashSandboxNetworkPolicy>;
    sandboxRunner: BashSandboxRunner;
    signal?: AbortSignal;
    permissionMode: BashPermissionMode;
    approval?: {
      store: BashApprovalStore;
      sessionId: string;
      ttlMs?: number;
    };
  }
): Promise<BashToolResult> {
  const startedAt = Date.now();
  const command = request.command.trim();
  let cwd: string;
  try {
    cwd = await resolveCwd(options.projectRoot, request.cwd);
  } catch (error) {
    return deniedResult(
      command,
      options.projectRoot,
      startedAt,
      error instanceof Error ? error.message : "cwd 不可用。"
    );
  }
  const timeoutMs = clampTimeout(request.timeoutMs, options.limits);

  if (command.length > options.limits.maxCommandChars) {
    return deniedResult(command, cwd, startedAt, "命令过长。");
  }

  const permission = checkBashPermission(command);
  if (!permission.allow) {
    return deniedResult(command, cwd, startedAt, permission.reason, "read-only", {
      mode: options.permissionMode,
      decision: "deny",
      decisionReason: { type: "static", message: permission.reason },
      matchedRules: [],
      suggestedRules: [],
      source: "local",
      orphaned: false,
    });
  }

  const ruleMatches = options.ruleStore?.matches(permission.normalizedCommand, cwd) ?? [];
  const suggestions = suggestBashPermissionRules(permission.normalizedCommand);
  const ruleDecision = decideFromRules(ruleMatches);
  if (ruleDecision?.behavior === "deny") {
    const debug = buildPermissionDebug({
      mode: options.permissionMode,
      risk: permission.risk,
      decision: "deny",
      ruleMatches,
      suggestions,
      reason: {
        type: "rule",
        behavior: "deny",
        ruleId: ruleDecision.rule.id,
        ruleContent: ruleDecision.rule.ruleContent,
      },
    });
    options.ruleStore?.recordUse(ruleDecision.rule.id);
    return deniedResult(
      permission.normalizedCommand,
      cwd,
      startedAt,
      `命令被持久化 deny 规则拒绝：${ruleDecision.rule.ruleContent}`,
      permission.risk,
      debug
    );
  }

  const askReason = askReasonForModeAndRules(options.permissionMode, permission.risk, ruleDecision);
  const debug = buildPermissionDebug({
    mode: options.permissionMode,
    risk: permission.risk,
    decision: askReason.behavior,
    ruleMatches,
    suggestions,
    reason: askReason.reason,
  });

  if (askReason.behavior === "deny") {
    return deniedResult(
      permission.normalizedCommand,
      cwd,
      startedAt,
      askReason.reason.type === "mode" ? askReason.reason.message : "命令被权限策略拒绝。",
      permission.risk,
      debug
    );
  }

  if (askReason.behavior === "ask") {
    if (!options.approval) {
      return deniedResult(
        permission.normalizedCommand,
        cwd,
        startedAt,
        "该命令需要交互式审批，但当前会话没有审批通道。",
        permission.risk,
        debug
      );
    }
    const approvalDecision = await options.approval.store.create({
      sessionId: options.approval.sessionId,
      command: permission.normalizedCommand,
      cwd,
      risk: permission.risk,
      description: request.description,
      mode: options.permissionMode,
      suggestedRules: suggestions,
      debug,
      ttlMs: options.approval.ttlMs,
    });
    if (approvalDecision.status !== "approved") {
      return {
        ...deniedResult(
          permission.normalizedCommand,
          cwd,
          startedAt,
          approvalDecision.status === "expired" ? "命令审批已过期。" : "用户拒绝执行该命令。",
          permission.risk,
          debug
        ),
        risk: permission.risk,
        approval: {
          required: true,
          status: approvalDecision.status,
          reason: askReason.reason.type,
          savedRule: approvalDecision.savedRule,
        },
      };
    }
    if (ruleDecision?.behavior === "ask") options.ruleStore?.recordUse(ruleDecision.rule.id);
    return executeBashCommand({
      command: permission.normalizedCommand,
      cwd,
      risk: permission.risk,
      startedAt,
      timeoutMs,
      limits: options.limits,
      signal: options.signal,
      sandboxMode: options.sandboxMode,
      sandboxFilesystem: options.sandboxFilesystem,
      sandboxNetwork: options.sandboxNetwork,
      sandboxRunner: options.sandboxRunner,
      projectRoot: options.projectRoot,
      approval: {
        required: true,
        status: "approved",
        reason: askReason.reason.type,
        savedRule: approvalDecision.savedRule,
      },
      permissionDebug: debug,
    });
  }

  if (ruleDecision?.behavior === "allow") options.ruleStore?.recordUse(ruleDecision.rule.id);
  return executeBashCommand({
    command: permission.normalizedCommand,
    cwd,
    risk: permission.risk,
    startedAt,
    timeoutMs,
    limits: options.limits,
    signal: options.signal,
    sandboxMode: options.sandboxMode,
    sandboxFilesystem: options.sandboxFilesystem,
    sandboxNetwork: options.sandboxNetwork,
    sandboxRunner: options.sandboxRunner,
    projectRoot: options.projectRoot,
    approval:
      permission.risk === "project-command"
        ? { required: false, status: "not_required", reason: askReason.reason.type }
        : { required: false, status: "not_required", reason: "read-only" },
    permissionDebug: debug,
  });
}

async function executeBashCommand(options: {
  command: string;
  cwd: string;
  risk: BashToolRisk;
  startedAt: number;
  timeoutMs: number;
  limits: BashToolLimits;
  signal?: AbortSignal;
  sandboxMode: BashSandboxMode;
  sandboxFilesystem?: Partial<BashSandboxFilesystemPolicy>;
  sandboxNetwork?: Partial<BashSandboxNetworkPolicy>;
  sandboxRunner: BashSandboxRunner;
  projectRoot: string;
  approval: BashToolResult["approval"];
  permissionDebug: BashPermissionDebug;
}): Promise<BashToolResult> {
  const sandbox = await options.sandboxRunner.wrap(
    options.command,
    {
      mode: options.sandboxMode,
      cwd: options.cwd,
      projectRoot: options.projectRoot,
      filesystem: options.sandboxFilesystem,
      network: options.sandboxNetwork,
    },
    options.signal
  );
  if (!sandbox.ok) {
    return deniedResult(
      options.command,
      options.cwd,
      options.startedAt,
      sandbox.reason,
      options.risk,
      options.permissionDebug,
      sandbox.debug
    );
  }

  return new Promise<BashToolResult>((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let settled = false;
    let timedOut = false;

    const child = spawn("bash", ["--noprofile", "--norc", "-lc", sandbox.command], {
      cwd: options.cwd,
      env: buildSafeEnv(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, options.timeoutMs);
    timeout.unref();

    const abort = () => {
      killProcessTree(child.pid);
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      const next = appendWithLimit(stdout, chunk.toString("utf8"), options.limits.maxOutputChars);
      stdout = next.value;
      outputTruncated ||= next.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = appendWithLimit(stderr, chunk.toString("utf8"), options.limits.maxOutputChars);
      stderr = next.value;
      outputTruncated ||= next.truncated;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      options.sandboxRunner.cleanupAfterCommand?.();
      const annotatedStderr = annotateSandboxStderr(options.sandboxRunner, options.command, stderr);
      resolveResult({
        ok: false,
        command: options.command,
        cwd: options.cwd,
        risk: options.risk,
        exitCode: 126,
        timedOut,
        durationMs: Date.now() - options.startedAt,
        stdout,
        stderr: prependLine(annotatedStderr, error.message),
        outputTruncated,
        approval: options.approval,
        permissionDebug: options.permissionDebug,
        sandboxDebug: sandbox.debug,
      });
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      options.sandboxRunner.cleanupAfterCommand?.();
      const annotatedStderr = annotateSandboxStderr(options.sandboxRunner, options.command, stderr);
      resolveResult({
        ok: code === 0 && !timedOut,
        command: options.command,
        cwd: options.cwd,
        risk: options.risk,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - options.startedAt,
        stdout,
        stderr: timedOut ? prependLine(annotatedStderr, `Command timed out after ${options.timeoutMs}ms.`) : annotatedStderr,
        outputTruncated,
        approval: options.approval,
        permissionDebug: options.permissionDebug,
        sandboxDebug: sandbox.debug,
      });
    });
  });
}

function decideFromRules(
  matches: BashPermissionRuleMatch[]
): (BashPermissionRuleMatch & { behavior: BashPermissionBehavior }) | null {
  const match = matches.find((item) => item.rule.behavior === "deny")
    ?? matches.find((item) => item.rule.behavior === "ask")
    ?? matches.find((item) => item.rule.behavior === "allow")
    ?? null;
  return match ? { ...match, behavior: match.rule.behavior } : null;
}

function askReasonForModeAndRules(
  mode: BashPermissionMode,
  risk: BashToolRisk,
  ruleDecision: (BashPermissionRuleMatch & { behavior: BashPermissionBehavior }) | null
): {
  behavior: BashPermissionBehavior;
  reason: BashPermissionDebug["decisionReason"];
} {
  if (mode === "bypassPermissions") {
    return {
      behavior: "allow",
      reason: { type: "mode", mode, message: "bypassPermissions 模式允许通过静态安全检查的命令直接执行。" },
    };
  }
  if (mode === "plan" && risk === "project-command") {
    return {
      behavior: "deny",
      reason: { type: "mode", mode, message: "plan 模式只允许只读 shell 检查，不执行项目脚本。" },
    };
  }
  if (ruleDecision?.behavior === "ask") {
    if (mode === "dontAsk") {
      return {
        behavior: "deny",
        reason: { type: "mode", mode, message: "dontAsk 模式会拒绝所有需要审批的命令。" },
      };
    }
    return {
      behavior: "ask",
      reason: {
        type: "rule",
        behavior: "ask",
        ruleId: ruleDecision.rule.id,
        ruleContent: ruleDecision.rule.ruleContent,
      },
    };
  }
  if (ruleDecision?.behavior === "allow") {
    return {
      behavior: "allow",
      reason: {
        type: "rule",
        behavior: "allow",
        ruleId: ruleDecision.rule.id,
        ruleContent: ruleDecision.rule.ruleContent,
      },
    };
  }
  if (risk === "project-command") {
    if (mode === "dontAsk") {
      return {
        behavior: "deny",
        reason: { type: "mode", mode, message: "dontAsk 模式会拒绝所有需要审批的命令。" },
      };
    }
    return {
      behavior: "ask",
      reason: { type: "default", message: "项目脚本需要用户审批。" },
    };
  }
  return {
    behavior: "allow",
    reason: { type: "default", message: "只读命令通过静态安全检查。" },
  };
}

function buildPermissionDebug(input: {
  mode: BashPermissionMode;
  risk: BashToolRisk;
  decision: BashPermissionBehavior;
  ruleMatches: BashPermissionRuleMatch[];
  suggestions: BashPermissionDebug["suggestedRules"];
  reason: BashPermissionDebug["decisionReason"];
}): BashPermissionDebug {
  return {
    mode: input.mode,
    baseRisk: input.risk,
    decision: input.decision,
    decisionReason: input.reason,
    matchedRules: input.ruleMatches,
    suggestedRules: input.suggestions,
    source: "local",
    orphaned: false,
  };
}

async function resolveCwd(projectRoot: string, requestedCwd: string | undefined): Promise<string> {
  const raw = requestedCwd?.trim() || ".";
  if (raw.includes("\0")) throw new Error("cwd 包含非法 NUL 字节。");
  const resolved = isAbsolute(raw) ? raw : resolve(projectRoot, raw);
  const rootReal = await realpath(projectRoot);
  const cwdReal = await realpath(resolved);
  await access(cwdReal, fsConstants.R_OK | fsConstants.X_OK);
  const rel = relative(rootReal, cwdReal);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("cwd 必须位于当前项目目录内。");
  }
  return cwdReal;
}

function clampTimeout(timeoutMs: number | undefined, limits: BashToolLimits): number {
  const raw = Math.trunc(timeoutMs ?? limits.timeoutMs);
  if (!Number.isFinite(raw)) return limits.timeoutMs;
  return Math.min(limits.maxTimeoutMs, Math.max(1_000, raw));
}

function buildSafeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  env.CI = "1";
  env.NO_COLOR = "1";
  env.AI2NAO_BASH_TOOL = "1";
  return env;
}

function appendWithLimit(current: string, chunk: string, maxChars: number): { value: string; truncated: boolean } {
  if (current.length >= maxChars) return { value: current, truncated: true };
  const next = current + chunk;
  if (next.length <= maxChars) return { value: next, truncated: false };
  return { value: next.slice(0, maxChars), truncated: true };
}

function prependLine(value: string, line: string): string {
  return value ? `${line}\n${value}` : line;
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      process.kill(pid, "SIGKILL");
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

function deniedResult(
  command: string,
  cwd: string,
  startedAt: number,
  reason: string,
  risk: BashToolRisk = "read-only",
  permissionDebug?: BashPermissionDebug,
  sandboxDebug?: BashSandboxDebug
): BashToolResult {
  return {
    ok: false,
    command,
    cwd,
    risk,
    exitCode: null,
    timedOut: false,
    durationMs: Date.now() - startedAt,
    stdout: "",
    stderr: "",
    outputTruncated: false,
    deniedReason: reason,
    permissionDebug,
    sandboxDebug,
  };
}

function annotateSandboxStderr(
  sandboxRunner: BashSandboxRunner,
  command: string,
  stderr: string
): string {
  return sandboxRunner.annotateStderrWithSandboxFailures?.(command, stderr) ?? stderr;
}
