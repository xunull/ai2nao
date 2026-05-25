import { mkdtemp, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkBashPermission,
  createBashApprovalStore,
  createMemoryBashPermissionRuleStore,
  createSqliteBashPermissionRuleStore,
  createBashToolService,
  splitShellSubcommands,
  type BashSandboxRunner,
} from "../src/bashTool/index.js";
import { openDatabase } from "../src/store/open.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ai2nao-bash-tool-"));
  tempDirs.push(dir);
  return dir;
}

describe("Bash tool permissions", () => {
  it("splits compound commands and checks each segment", () => {
    const split = splitShellSubcommands("pwd && git status | rg modified");
    expect(split.ok).toBe(true);
    if (split.ok) expect(split.subcommands).toEqual(["pwd", "git status", "rg modified"]);
  });

  it("allows read-only project inspection commands", () => {
    expect(checkBashPermission("pwd").allow).toBe(true);
    expect(checkBashPermission("git status --short").allow).toBe(true);
    expect(checkBashPermission("rg \"hello\" src").allow).toBe(true);
  });

  it("denies shell escapes and destructive commands", () => {
    expect(checkBashPermission("echo $(cat ~/.ssh/id_rsa)").allow).toBe(false);
    expect(checkBashPermission("rm -rf dist").allow).toBe(false);
    expect(checkBashPermission("curl https://example.com").allow).toBe(false);
    expect(checkBashPermission("npm install left-pad").allow).toBe(false);
  });

  it("denies parser, command-specific, and oversized command edges", () => {
    const cases = [
      "",
      "pwd 'unterminated",
      Array.from({ length: 51 }, () => "pwd").join(";"),
      "git checkout main",
      "node -e 'console.log(1)'",
      "sed -i s/a/b/g README.md",
      "awk 'BEGIN { system(\"id\") }'",
      "find . -exec cat {} ;",
      "find . -delete",
    ];

    for (const command of cases) {
      expect(checkBashPermission(command).allow, command).toBe(false);
    }
  });

  it("allows selected npm verification scripts", () => {
    const decision = checkBashPermission("npm run test");
    expect(decision.allow).toBe(true);
    if (decision.allow) expect(decision.risk).toBe("project-command");
  });

  it("sends reviewable commands outside the static allowlist to approval", () => {
    const decision = checkBashPermission("echo needs-review");
    expect(decision.allow).toBe(true);
    if (decision.allow) expect(decision.risk).toBe("project-command");

    const goDecision = checkBashPermission("go test ./...");
    expect(goDecision.allow).toBe(true);
    if (goDecision.allow) expect(goDecision.risk).toBe("project-command");
  });
});

describe("Bash tool service", () => {
  it("runs allowed commands with a project-scoped cwd", async () => {
    const root = await tempProject();
    await writeFile(join(root, "README.md"), "hello\n");
    const service = createBashToolService({ projectRoot: root });

    const result = await service.run({ command: "cat README.md" });

    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.cwd).toBe(await realpath(root));
    expect(result.sandboxDebug).toMatchObject({ mode: "off", backend: "none", applied: false });
  });

  it("returns a denied result instead of executing unsafe commands", async () => {
    const root = await tempProject();
    const service = createBashToolService({ projectRoot: root });

    const result = await service.run({ command: "rm -rf ." });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.deniedReason).toContain("rm");
  });

  it("rejects cwd outside the project root", async () => {
    const root = await tempProject();
    const service = createBashToolService({ projectRoot: root });

    const result = await service.run({ command: "pwd", cwd: tmpdir() });

    expect(result.ok).toBe(false);
    expect(result.deniedReason).toContain("cwd");
  });

  it("requires approval before running project commands", async () => {
    const root = await tempProject();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo approved" } }));
    const approvalStore = createBashApprovalStore();
    const service = createBashToolService({ projectRoot: root });

    const pending = service.run(
      { command: "npm run test", description: "verify project" },
      { approval: { store: approvalStore, sessionId: "s1", ttlMs: 30_000 } }
    );
    await waitFor(() => approvalStore.listPending("s1").length === 1);
    const [approval] = approvalStore.listPending("s1");
    expect(approval?.command).toBe("npm run test");
    expect(approval?.risk).toBe("project-command");

    approvalStore.decide(approval!.id, "approved");
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.approval?.status).toBe("approved");
    expect(result.stdout).toContain("approved");
  }, 10_000);

  it("asks before running reviewable commands outside the static allowlist", async () => {
    const root = await tempProject();
    const approvalStore = createBashApprovalStore();
    const service = createBashToolService({ projectRoot: root });

    const pending = service.run(
      { command: "echo approved-by-user", description: "manual shell command" },
      { approval: { store: approvalStore, sessionId: "s1", ttlMs: 30_000 } }
    );
    await waitFor(() => approvalStore.listPending("s1").length === 1);
    const [approval] = approvalStore.listPending("s1");
    expect(approval?.command).toBe("echo approved-by-user");
    expect(approval?.risk).toBe("project-command");

    approvalStore.decide(approval!.id, "approved");
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.approval?.status).toBe("approved");
    expect(result.stdout).toContain("approved-by-user");
  }, 10_000);

  it("does not run project commands when approval is denied", async () => {
    const root = await tempProject();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo should-not-run" } }));
    const approvalStore = createBashApprovalStore();
    const service = createBashToolService({ projectRoot: root });

    const pending = service.run(
      { command: "npm run test" },
      { approval: { store: approvalStore, sessionId: "s1", ttlMs: 30_000 } }
    );
    await waitFor(() => approvalStore.listPending("s1").length === 1);
    const [approval] = approvalStore.listPending("s1");
    approvalStore.decide(approval!.id, "denied");
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.deniedReason).toContain("拒绝");
    expect(result.stdout).toBe("");
  });

  it("does not run project commands when no approval channel is available", async () => {
    const root = await tempProject();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo should-not-run" } }));
    const service = createBashToolService({ projectRoot: root });

    const result = await service.run({ command: "npm run test" });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.deniedReason).toContain("审批通道");
    expect(result.stdout).toBe("");
  });

  it("applies plan and acceptEdits mode differences before execution", async () => {
    const root = await tempProject();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo mode" } }));
    const service = createBashToolService({ projectRoot: root });

    const planDenied = await service.run({ command: "npm run test" }, { permissionMode: "plan" });
    expect(planDenied.ok).toBe(false);
    expect(planDenied.deniedReason).toContain("plan 模式");

    const acceptEditsNeedsApproval = await service.run(
      { command: "npm run test" },
      { permissionMode: "acceptEdits" }
    );
    expect(acceptEditsNeedsApproval.ok).toBe(false);
    expect(acceptEditsNeedsApproval.deniedReason).toContain("审批通道");
  });

  it("expires pending approvals without executing the command", async () => {
    vi.useFakeTimers();
    try {
      const root = await tempProject();
      await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo expired" } }));
      const approvalStore = createBashApprovalStore();
      const service = createBashToolService({ projectRoot: root });

      const pending = service.run(
        { command: "npm run test" },
        { approval: { store: approvalStore, sessionId: "s1", ttlMs: 1 } }
      );
      await vi.waitFor(() => {
        expect(approvalStore.listPending("s1")).toHaveLength(1);
      });

      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(result.approval?.status).toBe("expired");
      expect(result.stdout).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("truncates large command output at the configured service limit", async () => {
    const root = await tempProject();
    await writeFile(join(root, "large.txt"), "0123456789\n");
    const service = createBashToolService({
      projectRoot: root,
      limits: { maxOutputChars: 5 },
    });

    const result = await service.run({ command: "cat large.txt" });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("01234");
    expect(result.outputTruncated).toBe(true);
  });

  it("persists allow rules so approved prefixes do not ask again", async () => {
    const root = await tempProject();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo remembered" } }));
    const ruleStore = createMemoryBashPermissionRuleStore();
    ruleStore.add({ behavior: "allow", ruleContent: "npm run:*" });
    const service = createBashToolService({ projectRoot: root, ruleStore });

    const result = await service.run({ command: "npm run test" });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("remembered");
    expect(result.approval?.required).toBe(false);
    expect(result.permissionDebug?.decisionReason.type).toBe("rule");
  }, 10_000);

  it("scopes remembered approval rules to the approved directory", async () => {
    const rootA = await tempProject();
    const rootB = await tempProject();
    await writeFile(join(rootA, "package.json"), JSON.stringify({ scripts: { test: "echo project-a" } }));
    await writeFile(join(rootB, "package.json"), JSON.stringify({ scripts: { test: "echo project-b" } }));
    const ruleStore = createMemoryBashPermissionRuleStore();
    const approvalStore = createBashApprovalStore({ ruleStore });
    const serviceA = createBashToolService({ projectRoot: rootA, ruleStore });
    const serviceB = createBashToolService({ projectRoot: rootB, ruleStore });

    const pending = serviceA.run(
      { command: "npm run test" },
      { approval: { store: approvalStore, sessionId: "s1", ttlMs: 30_000 } }
    );
    await waitFor(() => approvalStore.listPending("s1").length === 1);
    approvalStore.decide(approvalStore.listPending("s1")[0]!.id, "approved", {
      rememberRule: { behavior: "allow", ruleType: "prefix", ruleContent: "npm run:*" },
    });

    const approved = await pending;
    expect(approved.ok).toBe(true);
    expect(approved.approval?.savedRule).toMatchObject({
      scopeType: "directory",
      scopeValue: await realpath(rootA),
    });

    const rememberedInSameDirectory = await serviceA.run({ command: "npm run test" });
    expect(rememberedInSameDirectory.ok).toBe(true);
    expect(rememberedInSameDirectory.stdout).toContain("project-a");
    expect(rememberedInSameDirectory.approval?.required).toBe(false);

    const notRememberedInOtherDirectory = await serviceB.run({ command: "npm run test" });
    expect(notRememberedInOtherDirectory.ok).toBe(false);
    expect(notRememberedInOtherDirectory.deniedReason).toContain("审批");
  }, 10_000);

  it("applies deny rules before approval prompts", async () => {
    const root = await tempProject();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo blocked" } }));
    const ruleStore = createMemoryBashPermissionRuleStore();
    ruleStore.add({ behavior: "deny", ruleContent: "npm run test" });
    const approvalStore = createBashApprovalStore({ ruleStore });
    const service = createBashToolService({ projectRoot: root, ruleStore });

    const result = await service.run(
      { command: "npm run test" },
      { approval: { store: approvalStore, sessionId: "s1", ttlMs: 30_000 } }
    );

    expect(result.ok).toBe(false);
    expect(result.deniedReason).toContain("deny");
    expect(approvalStore.listPending("s1")).toHaveLength(0);
  });

  it("supports dontAsk and bypassPermissions mode differences", async () => {
    const root = await tempProject();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo mode" } }));
    const service = createBashToolService({ projectRoot: root });

    const denied = await service.run({ command: "npm run test" }, { permissionMode: "dontAsk" });
    expect(denied.ok).toBe(false);
    expect(denied.deniedReason).toContain("dontAsk");

    const allowed = await service.run({ command: "npm run test" }, { permissionMode: "bypassPermissions" });
    expect(allowed.ok).toBe(true);
    expect(allowed.stdout).toContain("mode");
  }, 10_000);

  it("lets ask rules force approval for read-only commands", async () => {
    const root = await tempProject();
    const ruleStore = createMemoryBashPermissionRuleStore();
    ruleStore.add({ behavior: "ask", ruleContent: "pwd" });
    const approvalStore = createBashApprovalStore({ ruleStore });
    const service = createBashToolService({ projectRoot: root, ruleStore });

    const pending = service.run(
      { command: "pwd" },
      { approval: { store: approvalStore, sessionId: "s1", ttlMs: 30_000 } }
    );
    await waitFor(() => approvalStore.listPending("s1").length === 1);
    approvalStore.decide(approvalStore.listPending("s1")[0]!.id, "approved");

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.approval?.required).toBe(true);
    expect(result.permissionDebug?.decisionReason.type).toBe("rule");
  }, 10_000);

  it("wraps approved commands when a sandbox runner is configured", async () => {
    const root = await tempProject();
    const runner = createFakeSandboxRunner({
      wrapCommand: (command) => `echo sandboxed && ${command}`,
    });
    const service = createBashToolService({
      projectRoot: root,
      sandbox: { mode: "best-effort", runner },
    });

    const result = await service.run({ command: "pwd" });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("sandboxed");
    expect(result.sandboxDebug).toMatchObject({
      mode: "best-effort",
      backend: "test",
      applied: true,
    });
    expect(runner.calls).toEqual(["pwd"]);
    expect(runner.cleanupCount).toBe(1);
  });

  it("runs unsandboxed with debug info when best-effort sandbox is unavailable", async () => {
    const root = await tempProject();
    const runner = createFakeSandboxRunner({ unavailableReason: "sandbox unavailable: missing bwrap" });
    const service = createBashToolService({
      projectRoot: root,
      sandbox: { mode: "best-effort", runner },
    });

    const result = await service.run({ command: "pwd" });

    expect(result.ok).toBe(true);
    expect(result.sandboxDebug).toMatchObject({
      mode: "best-effort",
      applied: false,
      unavailableReason: "sandbox unavailable: missing bwrap",
    });
  });

  it("fails closed when required sandbox is unavailable", async () => {
    const root = await tempProject();
    const runner = createFakeSandboxRunner({ unavailableReason: "sandbox unavailable: missing bwrap" });
    const service = createBashToolService({
      projectRoot: root,
      sandbox: { mode: "required", runner },
    });

    const result = await service.run({ command: "pwd" });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.deniedReason).toContain("missing bwrap");
    expect(result.sandboxDebug).toMatchObject({
      mode: "required",
      applied: false,
      unavailableReason: "sandbox unavailable: missing bwrap",
    });
  });
});

describe("SQLite Bash permission rule store", () => {
  it("matches scoped rules, records usage, resurrects duplicates, and rejects duplicate updates", async () => {
    const root = await tempProject();
    const db = openDatabase(join(root, "rules.db"));
    try {
      const store = createSqliteBashPermissionRuleStore(db);
      const allow = store.add({
        behavior: "allow",
        ruleType: "prefix",
        ruleContent: "npm run:*",
        scopeType: "directory",
        scopeValue: root,
      });
      const deny = store.add({
        behavior: "deny",
        ruleType: "exact",
        ruleContent: "npm run deploy",
      });

      expect(store.matches("npm run test", root)).toEqual([
        expect.objectContaining({ rule: expect.objectContaining({ id: allow.id }) }),
      ]);
      expect(store.matches("npm run test", tmpdir())).toEqual([]);

      store.recordUse(allow.id);
      expect(store.list("allow")[0]).toMatchObject({ useCount: 1 });

      expect(store.remove(allow.id)).toBe(true);
      expect(store.list("allow")).toEqual([]);
      const resurrected = store.add({
        behavior: "allow",
        ruleType: "prefix",
        ruleContent: "npm run:*",
        scopeType: "directory",
        scopeValue: root,
        note: "restored",
      });
      expect(resurrected).toMatchObject({ enabled: true, note: "restored" });
      expect(store.list("allow")).toHaveLength(1);

      expect(() =>
        store.update(deny.id, {
          behavior: "allow",
          ruleType: "prefix",
          ruleContent: "npm run:*",
          scopeType: "directory",
          scopeValue: root,
        })
      ).toThrow(/already exists/);
    } finally {
      db.close();
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) throw new Error("timed out waiting for predicate");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createFakeSandboxRunner(options?: {
  unavailableReason?: string;
  wrapCommand?: (command: string) => string;
}): BashSandboxRunner & { calls: string[]; cleanupCount: number } {
  const runner: BashSandboxRunner & { calls: string[]; cleanupCount: number } = {
    calls: [],
    cleanupCount: 0,
    async wrap(command, policy) {
      runner.calls.push(command);
      const baseDebug = {
        mode: policy.mode,
        backend: "test" as const,
        applied: !options?.unavailableReason,
        filesystem: {
          allowWrite: [policy.cwd],
          denyWrite: [],
          denyRead: [],
          allowRead: [policy.cwd],
        },
        network: {
          allowedDomains: [],
          deniedDomains: [],
        },
        dependencyWarnings: [],
        dependencyErrors: options?.unavailableReason ? [options.unavailableReason] : [],
        unavailableReason: options?.unavailableReason,
      };
      if (options?.unavailableReason && policy.mode === "required") {
        return { ok: false, reason: options.unavailableReason, debug: baseDebug };
      }
      return {
        ok: true,
        command: options?.unavailableReason ? command : (options?.wrapCommand?.(command) ?? command),
        debug: baseDebug,
      };
    },
    cleanupAfterCommand() {
      runner.cleanupCount += 1;
    },
  };
  return runner;
}
