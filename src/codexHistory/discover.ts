import { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { MAX_CODEX_FALLBACK_FILES } from "./constants.js";

export type CodexTranscriptFile = {
  id: string;
  filePath: string;
  mtimeMs: number;
  size: number;
};

function transcriptIdFromName(name: string): string {
  const stem = name.replace(/\.jsonl$/i, "");
  const m = stem.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return m ? m[1] : stem;
}

function isCodexRolloutName(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

function sortEntriesNewestFirst(entries: Dirent[]): Dirent[] {
  return [...entries].sort((a, b) => b.name.localeCompare(a.name));
}

async function walk(
  dir: string,
  rows: CodexTranscriptFile[],
  maxFiles: number
): Promise<void> {
  if (rows.length >= maxFiles) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of sortEntriesNewestFirst(entries)) {
    if (rows.length >= maxFiles) return;
    const path = join(dir, ent.name);
    if (ent.isDirectory()) {
      await walk(path, rows, maxFiles);
      continue;
    }
    if (!ent.isFile() || !isCodexRolloutName(ent.name)) continue;
    const st = await stat(path);
    rows.push({
      id: transcriptIdFromName(basename(path)),
      filePath: path,
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
  }
}

export async function listCodexTranscriptFiles(
  sessionsRoot: string,
  options?: { maxFiles?: number }
): Promise<{ files: CodexTranscriptFile[]; truncated: boolean; scannedCount: number }> {
  const maxFiles = Math.min(
    Math.max(options?.maxFiles ?? MAX_CODEX_FALLBACK_FILES, 1),
    5000
  );
  const files: CodexTranscriptFile[] = [];
  await walk(sessionsRoot, files, maxFiles + 1);
  const truncated = files.length > maxFiles;
  const bounded = truncated ? files.slice(0, maxFiles) : files;
  bounded.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  return { files: bounded, truncated, scannedCount: bounded.length };
}
