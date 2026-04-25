import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultVscodeStorageJsonPath, parseVscodeAppId } from "./paths.js";
import { hashWithSalt } from "./recent.js";
import type { VscodeAppId } from "./types.js";

export type VscodeWindowProject = {
  source: "lastActiveWindow" | "openedWindows";
  index: number;
  kind: "folder" | "workspace" | "empty";
  label: string;
  path: string | null;
  uri: string | null;
  remoteType: string | null;
  remoteAuthorityHash: string | null;
  backupPath: string | null;
};

export type VscodeWindowStateResult = {
  ok: boolean;
  app: VscodeAppId;
  storagePath: string | null;
  projects: VscodeWindowProject[];
  warnings: string[];
};

type WindowLike = {
  folder?: unknown;
  workspace?: unknown;
  backupPath?: unknown;
};

export function listVscodeWindowProjects(opts: {
  app?: string;
  storagePath?: string;
} = {}): VscodeWindowStateResult {
  const app = parseVscodeAppId(opts.app ?? "code");
  if (!app) throw new Error("invalid VS Code app");
  const storagePath = opts.storagePath ?? defaultVscodeStorageJsonPath(app);
  if (!storagePath) {
    return { ok: false, app, storagePath, projects: [], warnings: ["current platform is unsupported"] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(storagePath, "utf8"));
  } catch (e) {
    return {
      ok: false,
      app,
      storagePath,
      projects: [],
      warnings: [e instanceof Error ? e.message : String(e)],
    };
  }
  const windowsState =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as { windowsState?: unknown }).windowsState
      : undefined;
  if (!windowsState || typeof windowsState !== "object" || Array.isArray(windowsState)) {
    return { ok: false, app, storagePath, projects: [], warnings: ["storage.json has no windowsState object"] };
  }

  const projects: VscodeWindowProject[] = [];
  const seen = new Set<string>();
  const lastActive = (windowsState as { lastActiveWindow?: unknown }).lastActiveWindow;
  const last = parseWindowProject(lastActive, "lastActiveWindow", 0);
  if (last) pushUnique(projects, seen, last);
  const opened = (windowsState as { openedWindows?: unknown }).openedWindows;
  if (Array.isArray(opened)) {
    opened.forEach((windowRaw, index) => {
      const project = parseWindowProject(windowRaw, "openedWindows", index);
      if (project) pushUnique(projects, seen, project);
    });
  }
  return { ok: true, app, storagePath, projects, warnings: [] };
}

function parseWindowProject(
  raw: unknown,
  source: "lastActiveWindow" | "openedWindows",
  index: number
): VscodeWindowProject | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const window = raw as WindowLike;
  const folderUri = uriToString(window.folder);
  const workspaceUri = uriToString(window.workspace);
  const uri = folderUri ?? workspaceUri;
  const kind = folderUri ? "folder" : workspaceUri ? "workspace" : "empty";
  const backupPath = typeof window.backupPath === "string" ? window.backupPath : null;
  if (!uri && !backupPath) return null;
  const normalized = uri ? normalizeUri(uri) : null;
  return {
    source,
    index,
    kind,
    label: normalized?.label ?? "(empty window)",
    path: normalized?.path ?? null,
    uri: normalized?.uriRedacted ?? null,
    remoteType: normalized?.remoteType ?? null,
    remoteAuthorityHash: normalized?.remoteAuthorityHash ?? null,
    backupPath,
  };
}

function uriToString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const uri = value as {
    external?: unknown;
    fsPath?: unknown;
    scheme?: unknown;
    authority?: unknown;
    path?: unknown;
  };
  if (typeof uri.external === "string" && uri.external.trim()) return uri.external;
  if (typeof uri.fsPath === "string" && uri.fsPath.trim()) return `file://${uri.fsPath}`;
  if (typeof uri.scheme === "string") {
    const authority = typeof uri.authority === "string" ? uri.authority : "";
    const path = typeof uri.path === "string" ? uri.path : "";
    return `${uri.scheme}://${authority}${path}`;
  }
  return null;
}

function normalizeUri(uri: string): {
  label: string;
  path: string | null;
  uriRedacted: string;
  remoteType: string | null;
  remoteAuthorityHash: string | null;
} {
  if (uri.startsWith("file://")) {
    try {
      const path = fileURLToPath(uri);
      return { label: basename(path) || path, path, uriRedacted: uri, remoteType: null, remoteAuthorityHash: null };
    } catch {
      return { label: uri, path: null, uriRedacted: uri, remoteType: null, remoteAuthorityHash: null };
    }
  }
  let remoteType = "remote";
  let authority = rawAuthority(uri) ?? uri;
  let path = uri;
  try {
    const parsed = new URL(uri);
    authority = rawAuthority(uri) ?? (parsed.host || uri);
    path = parsed.pathname || uri;
    remoteType = parsed.protocol.replace(/:$/, "") || remoteType;
    const plus = authority.indexOf("+");
    if (plus > 0) remoteType = authority.slice(0, plus);
  } catch {
    /* keep fallback values */
  }
  const authorityHash = hashWithSalt("vscode-window-state-cli", authority);
  const pathHash = hashWithSalt("vscode-window-state-cli", path);
  return {
    label: `${remoteType}:${pathHash}`,
    path: null,
    uriRedacted: `${remoteType}://${authorityHash}/${pathHash}`,
    remoteType,
    remoteAuthorityHash: authorityHash,
  };
}

function rawAuthority(uri: string): string | null {
  const match = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\/([^/]+)/.exec(uri);
  return match?.[1] ?? null;
}

function pushUnique(
  projects: VscodeWindowProject[],
  seen: Set<string>,
  project: VscodeWindowProject
): void {
  const key = `${project.kind}:${project.path ?? project.uri ?? project.backupPath ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  projects.push(project);
}
