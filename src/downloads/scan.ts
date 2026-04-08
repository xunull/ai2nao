import { readdirSync, statSync, type Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";

export type ScanDownloadsResult = {
  roots: string[];
  inserted: number;
  skipped: number;
  errors: string[];
};

function toPosixRel(root: string, fullPath: string): string {
  const rel = relative(root, fullPath);
  if (rel.startsWith("..") || rel === "") return "";
  return rel.split(sep).join("/");
}

/**
 * Birthtime used for dedup: prefer `birthtimeMs` when it looks valid, else `mtimeMs`.
 */
export function effectiveBirthtimeMs(birthtimeMs: number, mtimeMs: number): number {
  const b = Math.floor(birthtimeMs);
  const m = Math.floor(mtimeMs);
  if (Number.isFinite(b) && b > 1_000_000) return b;
  return m;
}

function calendarDayLocal(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

function walkFilesUnderRoot(rootAbs: string): { full: string; rel: string }[] {
  const out: { full: string; rel: string }[] = [];
  const root = resolve(rootAbs);

  function walk(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      throw new Error(`cannot read directory ${dir}: ${String(e)}`);
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const rel = toPosixRel(root, full);
        if (rel) out.push({ full, rel });
      }
    }
  }

  walk(root);
  return out;
}

/**
 * Walk each root, INSERT OR IGNORE rows keyed by (root_path, rel_path, file_birthtime_ms).
 */
export function scanDownloads(
  db: Database.Database,
  rootsInput: string[]
): ScanDownloadsResult {
  const errors: string[] = [];
  const roots = rootsInput.map((r) => resolve(r));
  let inserted = 0;
  let skipped = 0;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO download_files (
      root_path, rel_path, file_birthtime_ms, file_mtime_ms, size_bytes,
      calendar_day, inserted_at
    ) VALUES (@root_path, @rel_path, @file_birthtime_ms, @file_mtime_ms, @size_bytes,
              @calendar_day, @inserted_at)`
  );

  const run = db.transaction(() => {
    const nowIso = new Date().toISOString();
    for (const root of roots) {
      let files: { full: string; rel: string }[];
      try {
        files = walkFilesUnderRoot(root);
      } catch (e) {
        errors.push(`${root}: ${String(e)}`);
        continue;
      }
      const rootPath = root;
      for (const { full, rel } of files) {
        let st;
        try {
          st = statSync(full);
        } catch (e) {
          errors.push(`${full}: ${String(e)}`);
          continue;
        }
        if (!st.isFile()) continue;
        const mtimeMs = st.mtimeMs;
        const birthMs = st.birthtimeMs;
        const keyMs = effectiveBirthtimeMs(birthMs, mtimeMs);
        const cal = calendarDayLocal(keyMs);
        const info = insert.run({
          root_path: rootPath,
          rel_path: rel,
          file_birthtime_ms: keyMs,
          file_mtime_ms: Math.floor(mtimeMs),
          size_bytes: st.size,
          calendar_day: cal,
          inserted_at: nowIso,
        });
        if (info.changes > 0) inserted += 1;
        else skipped += 1;
      }
    }
  });

  run();

  return { roots, inserted, skipped, errors };
}
