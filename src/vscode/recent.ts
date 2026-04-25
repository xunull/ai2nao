import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import type { ParsedVscodeRecentEntry, VscodeWarning } from "./types.js";

export class VscodeRecentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VscodeRecentParseError";
  }
}

type RecentEntryLike = {
  folderUri?: string;
  fileUri?: string;
  workspace?: { configPath?: string } | string;
  remoteAuthority?: string;
  label?: string;
};

export function parseRecentlyOpenedPathsList(
  raw: unknown,
  salt: string
): { entries: ParsedVscodeRecentEntry[]; warnings: VscodeWarning[]; emptySnapshot: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new VscodeRecentParseError("VS Code recent list has invalid top-level shape");
  }
  const entriesRaw = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entriesRaw)) {
    throw new VscodeRecentParseError("VS Code recent list is missing entries array");
  }
  if (entriesRaw.length === 0) return { entries: [], warnings: [], emptySnapshot: true };

  const entries: ParsedVscodeRecentEntry[] = [];
  const warnings: VscodeWarning[] = [];
  for (let i = 0; i < entriesRaw.length; i++) {
    const parsed = parseRecentEntry(entriesRaw[i], i, salt);
    if (parsed) entries.push(parsed);
    else {
      warnings.push({
        code: "entry_unknown_shape",
        message: "Skipped VS Code recent entry with unknown shape",
        context: { recentIndex: i },
      });
    }
  }
  return { entries, warnings, emptySnapshot: false };
}

function parseRecentEntry(
  raw: unknown,
  recentIndex: number,
  salt: string
): ParsedVscodeRecentEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as RecentEntryLike;
  const workspaceUri =
    typeof e.workspace === "string"
      ? e.workspace
      : typeof e.workspace?.configPath === "string"
        ? e.workspace.configPath
        : undefined;
  const uri = e.folderUri ?? e.fileUri ?? workspaceUri;
  if (typeof uri !== "string" || uri.trim().length === 0) return null;
  const kind = e.folderUri ? "folder" : e.fileUri ? "file" : "workspace";
  const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : labelFromUri(uri);
  return normalizeUri({
    kind,
    uri,
    label,
    recentIndex,
    remoteAuthority: e.remoteAuthority,
    salt,
  });
}

function normalizeUri(input: {
  kind: "folder" | "file" | "workspace";
  uri: string;
  label: string | null;
  recentIndex: number;
  remoteAuthority?: string;
  salt: string;
}): ParsedVscodeRecentEntry {
  if (input.uri.startsWith("file://")) {
    let path: string | null = null;
    try {
      path = fileURLToPath(input.uri);
    } catch {
      path = null;
    }
    return {
      kind: input.kind,
      recentIndex: input.recentIndex,
      uriRedacted: input.uri,
      path,
      label: input.label,
      remoteType: null,
      remoteAuthorityHash: null,
      remotePathHash: null,
    };
  }

  const remoteAuthority = input.remoteAuthority ?? remoteAuthorityFromUri(input.uri);
  const remoteType = remoteTypeFromAuthority(remoteAuthority) ?? remoteTypeFromUri(input.uri);
  const remoteAuthorityHash = hashWithSalt(input.salt, remoteAuthority || input.uri);
  const remotePath = remotePathFromUri(input.uri);
  const remotePathHash = hashWithSalt(input.salt, remotePath || input.uri);
  return {
    kind: input.kind,
    recentIndex: input.recentIndex,
    uriRedacted: `${remoteType ?? "remote"}://${remoteAuthorityHash}/${remotePathHash}`,
    path: null,
    label: input.label,
    remoteType: remoteType ?? "remote",
    remoteAuthorityHash,
    remotePathHash,
  };
}

function remoteAuthorityFromUri(uri: string): string | null {
  const raw = rawUriAuthority(uri);
  if (raw) return raw;
  try {
    return new URL(uri).host || null;
  } catch {
    return null;
  }
}

function rawUriAuthority(uri: string): string | null {
  const match = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\/([^/]+)/.exec(uri);
  return match?.[1] ?? null;
}

function remotePathFromUri(uri: string): string | null {
  try {
    return new URL(uri).pathname || null;
  } catch {
    return null;
  }
}

function remoteTypeFromAuthority(authority: string | undefined | null): string | null {
  if (!authority) return null;
  const idx = authority.indexOf("+");
  return idx > 0 ? authority.slice(0, idx) : authority;
}

function remoteTypeFromUri(uri: string): string | null {
  try {
    const u = new URL(uri);
    return u.protocol.replace(/:$/, "") || null;
  } catch {
    return null;
  }
}

function labelFromUri(uri: string): string | null {
  try {
    const u = new URL(uri);
    const path = decodeURIComponent(u.pathname);
    const b = basename(path);
    return b || u.host || null;
  } catch {
    return null;
  }
}

export function hashWithSalt(salt: string, value: string): string {
  return createHash("sha256").update(salt).update("\0").update(value).digest("hex").slice(0, 24);
}
