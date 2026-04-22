import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative, sep } from "node:path";
import { DEFAULT_EXCLUDE_DIR_NAMES } from "../config.js";

export type FileToIndex = {
  absPath: string;
  relPath: string;
  mtimeMs: number;
  body: string;
};

export type CorpusFileEntry = {
  relPath: string;
  absPath: string;
  mtimeMs: number;
};

function shouldSkipDirName(name: string, respectExcludes: boolean): boolean {
  if (name === ".git") return true;
  if (!respectExcludes) return false;
  return DEFAULT_EXCLUDE_DIR_NAMES.has(name);
}

export type ListCorpusFilesResult = {
  files: CorpusFileEntry[];
  /** Non-fatal: unreadable dirs, permission, etc. */
  warnings: string[];
};

/**
 * Recursively list text files under `root` with matching extensions
 * (`includeExtensions` lowercased, with leading dot).
 */
export function listCorpusFiles(
  root: string,
  includeExtensions: Set<string>,
  respectDefaultExcludes: boolean
): ListCorpusFilesResult {
  const out: CorpusFileEntry[] = [];
  const warnings: string[] = [];

  if (!existsSync(root)) {
    return { files: [], warnings: [`corpus root does not exist: ${root}`] };
  }
  let rootSt;
  try {
    rootSt = statSync(root);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { files: [], warnings: [`cannot stat corpus root ${root}: ${msg}`] };
  }
  if (!rootSt.isDirectory()) {
    return { files: [], warnings: [`corpus root is not a directory: ${root}`] };
  }

  function walk(dir: string) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`skip directory (unreadable): ${dir} — ${msg}`);
      return;
    }
    for (const d of entries) {
      const name = d.name;
      if (shouldSkipDirName(name, respectDefaultExcludes)) continue;
      const abs = join(dir, name);
      if (d.isDirectory()) {
        walk(abs);
        continue;
      }
      if (d.isFile()) {
        const ext = extname(name).toLowerCase();
        if (!includeExtensions.has(ext)) continue;
        let mtimeMs: number;
        try {
          mtimeMs = Math.floor(statSync(abs).mtimeMs);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          warnings.push(`skip file: ${abs} — ${msg}`);
          continue;
        }
        out.push({
          relPath: relative(root, abs).split(sep).join("/"),
          absPath: abs,
          mtimeMs,
        });
        continue;
      }
      // Symlinks or other types: follow with stat
      let st: import("node:fs").Stats;
      try {
        st = statSync(abs);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        warnings.push(`skip entry: ${abs} — ${msg}`);
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
      } else if (st.isFile()) {
        const ext = extname(name).toLowerCase();
        if (!includeExtensions.has(ext)) continue;
        out.push({
          relPath: relative(root, abs).split(sep).join("/"),
          absPath: abs,
          mtimeMs: Math.floor(st.mtimeMs),
        });
      }
    }
  }
  walk(root);
  return { files: out, warnings };
}

export function readFileLimited(
  absPath: string,
  relPath: string,
  mtimeMs: number,
  maxBytes: number
):
  | { ok: true; data: FileToIndex }
  | { ok: false; error: string } {
  let st;
  try {
    st = statSync(absPath);
  } catch (e) {
    return { ok: false, error: `${relPath}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (st.size > maxBytes) {
    return {
      ok: false,
      error: `${relPath}: file too large (${st.size} bytes, max ${maxBytes})`,
    };
  }
  try {
    const body = readFileSync(absPath, "utf8");
    return { ok: true, data: { absPath, relPath, mtimeMs, body } };
  } catch (e) {
    return { ok: false, error: `${relPath}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
