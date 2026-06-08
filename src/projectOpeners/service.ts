import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { runBoundedCommand } from "../software/command.js";
import type { OpenProjectRequest, OpenProjectResult, ProjectOpener, ProjectOpenerId } from "./types.js";

export class ProjectOpenError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ProjectOpenError";
    this.status = status;
  }
}

export type ProjectOpenCommand = {
  file: string;
  args: string[];
};

export type ProjectOpenerDeps = {
  platform?: NodeJS.Platform;
  statPath?: typeof stat;
  runCommand?: (file: string, args: string[]) => Promise<unknown>;
};

export const DEFAULT_PROJECT_OPENERS: ProjectOpener[] = [
  { id: "vscode", label: "VS Code", kind: "editor" },
  { id: "cursor", label: "Cursor", kind: "editor" },
  { id: "warp", label: "Warp", kind: "terminal" },
  { id: "iterm2", label: "iTerm2", kind: "terminal" },
];

const PROJECT_OPENER_IDS = new Set<ProjectOpenerId>(
  DEFAULT_PROJECT_OPENERS.map((opener) => opener.id)
);

export function listProjectOpeners(): ProjectOpener[] {
  return DEFAULT_PROJECT_OPENERS;
}

export async function openProject(
  request: OpenProjectRequest,
  deps: ProjectOpenerDeps = {}
): Promise<OpenProjectResult> {
  const opener = parseProjectOpenerId(request.opener);
  const projectPath = validateProjectPathInput(request.path);
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new ProjectOpenError(400, "project openers are currently supported on macOS only");
  }

  const statPath = deps.statPath ?? stat;
  let info;
  try {
    info = await statPath(projectPath);
  } catch {
    throw new ProjectOpenError(404, "project path does not exist");
  }
  if (!info.isDirectory()) {
    throw new ProjectOpenError(400, "project path must be a directory");
  }

  const command = buildProjectOpenCommand(opener, projectPath);
  const runCommand =
    deps.runCommand ??
    ((file: string, args: string[]) =>
      runBoundedCommand(file, args, { timeoutMs: 10_000, maxBuffer: 64 * 1024 }));
  await runCommand(command.file, command.args);
  return { ok: true, opener, path: projectPath };
}

export function buildProjectOpenCommand(opener: ProjectOpenerId, projectPath: string): ProjectOpenCommand {
  switch (opener) {
    case "vscode":
      return { file: "open", args: ["-a", "Visual Studio Code", projectPath] };
    case "cursor":
      return { file: "open", args: ["-a", "Cursor", projectPath] };
    case "warp":
      return { file: "open", args: [warpProjectUrl(projectPath)] };
    case "iterm2":
      return { file: "osascript", args: ["-e", ITERM2_OPEN_SCRIPT, projectPath] };
  }
}

function parseProjectOpenerId(raw: string): ProjectOpenerId {
  if (PROJECT_OPENER_IDS.has(raw as ProjectOpenerId)) return raw as ProjectOpenerId;
  throw new ProjectOpenError(400, "unknown project opener");
}

function validateProjectPathInput(raw: string): string {
  const projectPath = String(raw ?? "").trim();
  if (!projectPath) throw new ProjectOpenError(400, "project path is required");
  if (!isAbsolute(projectPath)) throw new ProjectOpenError(400, "project path must be absolute");
  return projectPath;
}

function warpProjectUrl(projectPath: string): string {
  const params = new URLSearchParams({ path: projectPath });
  return `warp://action/new_window?${params.toString()}`;
}

const ITERM2_OPEN_SCRIPT = `
on run argv
  set projectPath to item 1 of argv
  tell application "iTerm2"
    activate
    set newWindow to (create window with default profile)
    tell current session of newWindow
      write text "cd " & quoted form of projectPath
    end tell
  end tell
end run
`.trim();
