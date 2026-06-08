import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerProjectOpenerRoutes } from "../src/projectOpeners/routes.js";

describe("projectOpeners routes", () => {
  it("lists openers and opens a valid project directory", async () => {
    const dir = join(tmpdir(), `ai2nao-project-openers-routes-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const runCommand = vi.fn(async () => undefined);
    const app = new Hono();
    registerProjectOpenerRoutes(app, { platform: "darwin", runCommand });

    const list = await app.request("http://x/api/project-openers");
    expect(list.status).toBe(200);
    const listBody = await list.json() as { openers: Array<{ id: string; label: string }> };
    expect(listBody.openers.map((opener) => opener.id)).toEqual(["vscode", "cursor", "warp", "iterm2"]);

    const opened = await app.request("http://x/api/project-openers/open", {
      method: "POST",
      body: JSON.stringify({ opener: "cursor", path: dir }),
      headers: { "Content-Type": "application/json" },
    });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toEqual({ ok: true, opener: "cursor", path: dir });
    expect(runCommand).toHaveBeenCalledWith("open", ["-a", "Cursor", dir]);
  });
});
