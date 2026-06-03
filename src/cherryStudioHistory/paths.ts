import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function expandHomePath(pathInput: string): string {
  if (pathInput === "~") return homedir();
  if (pathInput.startsWith("~/")) return join(homedir(), pathInput.slice(2));
  return pathInput;
}

export function defaultCherryStudioRoot(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "CherryStudio");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "CherryStudio");
  }
  return join(homedir(), ".config", "CherryStudio");
}

export function resolveCherryStudioRoot(root?: string): string {
  const clean = (root ?? "").trim();
  return resolve(clean ? expandHomePath(clean) : defaultCherryStudioRoot());
}

export function resolveCherryStudioExportRoot(exportRoot?: string): string | undefined {
  const clean = (exportRoot ?? process.env.CHERRY_STUDIO_EXPORT_ROOT ?? "").trim();
  return clean ? resolve(expandHomePath(clean)) : undefined;
}

export function cherryStudioAgentsDbPath(root: string): string {
  return join(root, "Data", "agents.db");
}

export function cherryStudioIndexedDbPath(root: string): string {
  return join(root, "IndexedDB", "file__0.indexeddb.leveldb");
}

export function cherryStudioIndexedDbRoot(root: string): string {
  return join(root, "IndexedDB");
}
