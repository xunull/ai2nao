import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStrictWorkspaceBashSandboxPolicy,
  defaultBashSandboxConfig,
  normalizeBashSandboxConfig,
  parseBashSandboxConfigJson,
  readBashSandboxConfig,
  serviceSandboxConfig,
  writeBashSandboxConfig,
} from "../src/bashTool/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempConfigEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), "ai2nao-bash-sandbox-"));
  tempDirs.push(dir);
  return { ...process.env, AI2NAO_BASH_SANDBOX_CONFIG: join(dir, "sandbox.json") };
}

describe("Bash sandbox config", () => {
  it("uses safe defaults when no config file exists", async () => {
    const env = await tempConfigEnv();
    const read = readBashSandboxConfig(env, "/repo");

    expect(read.configured).toBe(false);
    expect(read.config.mode).toBe("off");
    expect(read.config.filesystem.allowWrite).toContain("/repo");
    expect(read.config.filesystem.denyRead.some((path) => path.includes(".ssh"))).toBe(true);
    expect(read.config.network.allowedDomains).toEqual([]);
  });

  it("normalizes and persists filesystem and network policies", async () => {
    const env = await tempConfigEnv();
    const config = normalizeBashSandboxConfig(
      {
        version: 1,
        mode: "required",
        filesystem: {
          allowWrite: ["/repo", "/repo", ""],
          denyWrite: [".env"],
          denyRead: ["~/.ssh"],
          allowRead: ["/repo"],
        },
        network: {
          allowedDomains: ["api.github.com", " api.github.com "],
          deniedDomains: ["bad.example"],
        },
      },
      "/repo"
    );

    const path = writeBashSandboxConfig(config, env);
    const read = readBashSandboxConfig(env, "/repo");

    expect(path).toBe(env.AI2NAO_BASH_SANDBOX_CONFIG);
    expect(read.configured).toBe(true);
    expect(read.config).toMatchObject({
      mode: "required",
      filesystem: {
        allowWrite: ["/repo"],
        denyWrite: [".env"],
        denyRead: ["~/.ssh"],
        allowRead: ["/repo"],
      },
      network: {
        allowedDomains: ["api.github.com"],
        deniedDomains: ["bad.example"],
      },
    });
    expect(serviceSandboxConfig(read.config)).toMatchObject({
      mode: "required",
      network: { allowedDomains: ["api.github.com"] },
    });
  });

  it("rejects invalid JSON shapes", () => {
    expect(parseBashSandboxConfigJson("{", "/repo")).toBeNull();
    expect(() => normalizeBashSandboxConfig({ mode: "always" }, "/repo")).toThrow(/mode/);
    expect(() =>
      normalizeBashSandboxConfig({ mode: "off", filesystem: { allowWrite: "src" } }, "/repo")
    ).toThrow(/allowWrite/);
  });

  it("fills missing policy sections from defaults", () => {
    const defaults = defaultBashSandboxConfig("/repo");
    const config = normalizeBashSandboxConfig({ mode: "best-effort" }, "/repo");

    expect(config.mode).toBe("best-effort");
    expect(config.filesystem).toEqual(defaults.filesystem);
    expect(config.network).toEqual(defaults.network);
  });

  it("builds a strict workspace policy for real OS sandbox enforcement", () => {
    const policy = createStrictWorkspaceBashSandboxPolicy("/repo");

    expect(policy.network.allowedDomains).toEqual([]);
    expect(policy.network.deniedDomains).toEqual([]);
    expect(policy.filesystem.allowWrite).toEqual(["/repo"]);
    expect(policy.filesystem.allowRead).toEqual(["/repo"]);
    expect(policy.filesystem.denyRead).toContain(homedir());
    expect(policy.filesystem.denyRead).toContain(join(homedir(), ".ssh"));
    expect(policy.filesystem.denyWrite).toContain("/repo/.env");
    expect(policy.filesystem.denyWrite).toContain("/repo/.git/hooks");
  });
});
