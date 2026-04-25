import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { listVscodeWindowProjects } from "../src/vscode/windowState.js";

describe("VS Code storage.json window state", () => {
  it("lists last active and opened project windows", () => {
    const base = join(tmpdir(), `ai2nao-vscode-window-state-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    const storagePath = join(base, "storage.json");
    writeFileSync(
      storagePath,
      JSON.stringify({
        windowsState: {
          lastActiveWindow: { folder: "file:///tmp/current", backupPath: "/tmp/backup-current" },
          openedWindows: [
            { folder: "file:///tmp/current", backupPath: "/tmp/backup-current" },
            { workspace: { scheme: "file", path: "/tmp/app.code-workspace" } },
            {
              folder: "vscode-remote://ssh-remote+alice@example.com/home/alice/private",
              backupPath: "/tmp/backup-remote",
            },
          ],
        },
      })
    );

    const result = listVscodeWindowProjects({ storagePath });

    expect(result.ok).toBe(true);
    expect(result.projects).toHaveLength(3);
    expect(result.projects[0]).toMatchObject({
      source: "lastActiveWindow",
      kind: "folder",
      path: "/tmp/current",
    });
    expect(result.projects[1]).toMatchObject({
      source: "openedWindows",
      kind: "workspace",
      path: "/tmp/app.code-workspace",
    });
    const remoteText = JSON.stringify(result.projects[2]);
    expect(remoteText).not.toContain("alice");
    expect(remoteText).not.toContain("example.com");
    expect(result.projects[2].uri).toMatch(/^ssh-remote:\/\//);
  });

  it("returns a warning result when storage.json cannot be read", () => {
    const result = listVscodeWindowProjects({ storagePath: join(tmpdir(), "nope-storage.json") });
    expect(result.ok).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
