import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { VscodeAppId } from "./types.js";

const VSCODE_APP_IDS = ["code", "code-insiders", "vscodium", "cursor"] as const;

export function parseVscodeAppId(raw: string): VscodeAppId | null {
  const t = raw.trim().toLowerCase();
  return (VSCODE_APP_IDS as readonly string[]).includes(t) ? (t as VscodeAppId) : null;
}

export function vscodeAppIds(): readonly VscodeAppId[] {
  return VSCODE_APP_IDS;
}

export function defaultVscodeStatePath(app: VscodeAppId = "code"): string | null {
  return joinVscodeGlobalStoragePath(app, "state.vscdb");
}

export function defaultVscodeStorageJsonPath(app: VscodeAppId = "code"): string | null {
  return joinVscodeGlobalStoragePath(app, "storage.json");
}

function joinVscodeGlobalStoragePath(app: VscodeAppId, fileName: string): string | null {
  const h = homedir();
  if (process.platform === "darwin") {
    const base =
      app === "code"
        ? "Code"
        : app === "code-insiders"
          ? "Code - Insiders"
          : app === "vscodium"
          ? "VSCodium"
          : "Cursor";
    return join(h, "Library", "Application Support", base, "User", "globalStorage", fileName);
  }
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA ?? join(h, "AppData", "Roaming");
    const base =
      app === "code"
        ? "Code"
        : app === "code-insiders"
          ? "Code - Insiders"
          : app === "vscodium"
          ? "VSCodium"
          : "Cursor";
    return join(roaming, base, "User", "globalStorage", fileName);
  }
  if (process.platform === "linux") {
    const base =
      app === "code"
        ? "Code"
        : app === "code-insiders"
          ? "Code - Insiders"
          : app === "vscodium"
          ? "VSCodium"
          : "Cursor";
    return join(h, ".config", base, "User", "globalStorage", fileName);
  }
  return null;
}

export function getVscodeStatus(app: VscodeAppId = "code") {
  const statePath = defaultVscodeStatePath(app);
  return {
    platform: process.platform,
    app,
    profile: "default",
    supported: statePath != null,
    statePath,
    exists: statePath ? existsSync(statePath) : false,
  };
}
