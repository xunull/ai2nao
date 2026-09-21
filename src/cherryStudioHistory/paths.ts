import { homedir } from "node:os";
import { join, resolve } from "node:path";

function expandHomePath(pathInput: string): string {
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

/**
 * Cherry Studio 2.0.14 起的唯一数据库。在那之前对话在
 * `IndexedDB/file__0.indexeddb.leveldb`、agent 在 `Data/agents.db`,
 * 两处自迁移当天起不再写入,本仓库也不再读 —— 见
 * docs/adr/0003-cherry-studio-sqlite.md。
 */
export function cherryStudioDbPath(root: string): string {
  return join(root, "Data", "cherrystudio.sqlite");
}
