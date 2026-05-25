import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createBashApprovalStore } from "../src/bashTool/index.js";
import { registerBashApprovalRoutes } from "../src/bashTool/routes.js";

const tempDirs: string[] = [];
let previousConfigPath: string | undefined;

afterEach(async () => {
  if (previousConfigPath === undefined) {
    delete process.env.AI2NAO_BASH_SANDBOX_CONFIG;
  } else {
    process.env.AI2NAO_BASH_SANDBOX_CONFIG = previousConfigPath;
  }
  previousConfigPath = undefined;
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function appWithTempConfig(): Promise<Hono> {
  const dir = await mkdtemp(join(tmpdir(), "ai2nao-bash-sandbox-routes-"));
  tempDirs.push(dir);
  previousConfigPath = process.env.AI2NAO_BASH_SANDBOX_CONFIG;
  process.env.AI2NAO_BASH_SANDBOX_CONFIG = join(dir, "sandbox.json");
  const app = new Hono();
  registerBashApprovalRoutes(app, createBashApprovalStore());
  return app;
}

describe("Bash sandbox routes", () => {
  it("returns sandbox status with defaults before a config file exists", async () => {
    const app = await appWithTempConfig();

    const res = await app.request("/api/bash-sandbox/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configured: boolean;
      config: { mode: string; filesystem: { allowWrite: string[] } };
      dependencies: { ok: boolean; errors: string[] };
    };

    expect(body.configured).toBe(false);
    expect(body.config.mode).toBe("off");
    expect(body.config.filesystem.allowWrite.length).toBeGreaterThan(0);
    expect(Array.isArray(body.dependencies.errors)).toBe(true);
  });

  it("saves and reloads sandbox config", async () => {
    const app = await appWithTempConfig();

    const save = await app.request("/api/bash-sandbox/config", {
      method: "POST",
      body: JSON.stringify({
        version: 1,
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
      }),
      headers: { "content-type": "application/json" },
    });

    expect(save.status).toBe(200);
    const saved = (await save.json()) as {
      configured: boolean;
      config: { mode: string; network: { allowedDomains: string[] } };
    };
    expect(saved.configured).toBe(true);
    expect(saved.config.mode).toBe("required");
    expect(saved.config.network.allowedDomains).toEqual(["api.github.com"]);

    const invalid = await app.request("/api/bash-sandbox/config", {
      method: "POST",
      body: JSON.stringify({ mode: "always" }),
      headers: { "content-type": "application/json" },
    });
    expect(invalid.status).toBe(400);
  });
});
