import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkBashSandboxDependencies,
  createBashToolService,
  createStrictWorkspaceBashSandboxPolicy,
  isBashSandboxSupportedPlatform,
} from "../src/bashTool/index.js";

const sandboxDependency = checkBashSandboxDependencies();
const sandboxCanApply = sandboxExecCanApplyInCurrentHarness();
const describeWithSandbox =
  isBashSandboxSupportedPlatform() && sandboxDependency.errors.length === 0 && sandboxCanApply
    ? describe
    : describe.skip;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describeWithSandbox("Bash sandbox OS integration", () => {
  it("blocks network access even when an approved npm script tries to fetch", async () => {
    const root = await tempProject();
    const result = await runSandboxedProbe(
      root,
      `try {
        await fetch("https://example.com", { signal: AbortSignal.timeout(1500) });
        console.log("NETWORK_OK");
        process.exit(0);
      } catch (error) {
        console.error("NETWORK_BLOCKED:" + error.message);
        process.exit(42);
      }`
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(42);
    expect(result.stdout).not.toContain("NETWORK_OK");
    expect(result.stderr).toContain("NETWORK_BLOCKED");
    expect(result.sandboxDebug).toMatchObject({
      mode: "required",
      backend: "anthropic-sandbox-runtime",
      applied: true,
      network: { allowedDomains: [] },
    });
  }, 15_000);

  it("blocks reads from denied sensitive paths before secret content can leak", async () => {
    const root = await tempProject();
    const secretDir = await tempDir("ai2nao-fake-ssh-");
    const secretPath = join(secretDir, "id_rsa");
    const secret = "AI2NAO_FAKE_SSH_SECRET";
    await writeFile(secretPath, secret, "utf8");
    const policy = createStrictWorkspaceBashSandboxPolicy(root);

    const result = await runSandboxedProbe(
      root,
      `import { readFileSync } from "node:fs";
       try {
         console.log(readFileSync(${JSON.stringify(secretPath)}, "utf8"));
         process.exit(0);
       } catch (error) {
         console.error("READ_BLOCKED:" + error.code + ":" + error.message);
         process.exit(43);
       }`,
      {
        filesystem: {
          ...policy.filesystem,
          denyRead: [...policy.filesystem.denyRead, secretDir],
        },
        network: policy.network,
      }
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(43);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).toContain("READ_BLOCKED");
    expect(result.stderr).toContain("EPERM");
    expect(result.sandboxDebug).toMatchObject({
      mode: "required",
      backend: "anthropic-sandbox-runtime",
      applied: true,
    });
    expect(result.sandboxDebug?.filesystem.denyRead).toContain(secretDir);
  }, 15_000);

  it("blocks writes outside the workspace when strict policy only allows project writes", async () => {
    const root = await tempProject();
    const outside = await tempDir("ai2nao-sandbox-outside-");
    const outsidePath = join(outside, "pwned.txt");

    const result = await runSandboxedProbe(
      root,
      `import { writeFileSync } from "node:fs";
       try {
         writeFileSync(${JSON.stringify(outsidePath)}, "PWNED", "utf8");
         console.log("WRITE_OK");
         process.exit(0);
       } catch (error) {
         console.error("WRITE_BLOCKED:" + error.code + ":" + error.message);
         process.exit(44);
       }`
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(44);
    expect(result.stdout).not.toContain("WRITE_OK");
    expect(result.stderr).toContain("WRITE_BLOCKED");
    expect(result.stderr).toContain("EPERM");
    expect(result.sandboxDebug).toMatchObject({
      mode: "required",
      backend: "anthropic-sandbox-runtime",
      applied: true,
    });
    expect(result.sandboxDebug?.filesystem.allowWrite).toEqual([root]);
    await expect(access(outsidePath)).rejects.toThrow();
  }, 15_000);
});

async function tempProject(): Promise<string> {
  const root = await tempDir("ai2nao-bash-sandbox-project-");
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ scripts: { test: "node probe.mjs" } }, null, 2)}\n`,
    "utf8"
  );
  return root;
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function runSandboxedProbe(
  root: string,
  source: string,
  policy = createStrictWorkspaceBashSandboxPolicy(root)
) {
  await writeFile(join(root, "probe.mjs"), `${source}\n`, "utf8");
  const service = createBashToolService({
    projectRoot: root,
    limits: { timeoutMs: 5_000, maxTimeoutMs: 5_000 },
    sandbox: {
      mode: "required",
      filesystem: policy.filesystem,
      network: policy.network,
    },
  });
  return service.run(
    { command: "npm run test", timeoutMs: 5_000, description: "sandbox integration probe" },
    { permissionMode: "bypassPermissions" }
  );
}

function sandboxExecCanApplyInCurrentHarness(): boolean {
  if (process.platform !== "darwin") return false;
  const probe = spawnSync("sandbox-exec", ["-p", "(version 1) (allow default)", "true"], {
    encoding: "utf8",
    stdio: "ignore",
    timeout: 5_000,
  });
  return probe.status === 0;
}
