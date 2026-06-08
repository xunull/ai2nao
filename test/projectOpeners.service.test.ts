import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  buildProjectOpenCommand,
  openProject,
  ProjectOpenError,
} from "../src/projectOpeners/service.js";

describe("projectOpeners service", () => {
  it("opens editors through macOS open without shell command strings", async () => {
    const dir = join(tmpdir(), `ai2nao-project-opener-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const runCommand = vi.fn(async () => undefined);

    await expect(
      openProject({ opener: "vscode", path: dir }, { platform: "darwin", runCommand })
    ).resolves.toEqual({ ok: true, opener: "vscode", path: dir });

    expect(runCommand).toHaveBeenCalledWith("open", ["-a", "Visual Studio Code", dir]);
  });

  it("builds Warp and iTerm2 commands that preserve the project directory", () => {
    const dir = "/Users/quincy/work/my project";
    const warpQuery = new URLSearchParams({ path: dir }).toString();
    expect(buildProjectOpenCommand("warp", dir)).toEqual({
      file: "open",
      args: [`warp://action/new_window?${warpQuery}`],
    });

    const iterm = buildProjectOpenCommand("iterm2", dir);
    expect(iterm.file).toBe("osascript");
    expect(iterm.args[iterm.args.length - 1]).toBe(dir);
    expect(iterm.args.join("\n")).toContain("quoted form of projectPath");
    expect(iterm.args.join("\n")).toContain("create window with default profile");
  });

  it("rejects relative, missing, file, unknown, and non-macOS open requests", async () => {
    await expect(
      openProject({ opener: "vscode", path: "relative/path" }, { platform: "darwin" })
    ).rejects.toMatchObject({ status: 400, message: "project path must be absolute" });

    await expect(
      openProject({ opener: "vscode", path: "/tmp/ai2nao-missing-project-open" }, { platform: "darwin" })
    ).rejects.toMatchObject({ status: 404, message: "project path does not exist" });

    const file = join(tmpdir(), `ai2nao-project-opener-file-${Date.now()}`);
    await writeFile(file, "x");
    await expect(
      openProject({ opener: "vscode", path: file }, { platform: "darwin" })
    ).rejects.toMatchObject({ status: 400, message: "project path must be a directory" });

    await expect(
      openProject({ opener: "bad" as never, path: "/tmp" }, { platform: "darwin" })
    ).rejects.toBeInstanceOf(ProjectOpenError);

    await expect(
      openProject({ opener: "vscode", path: "/tmp" }, { platform: "linux" })
    ).rejects.toMatchObject({ status: 400, message: "project openers are currently supported on macOS only" });
  });
});
