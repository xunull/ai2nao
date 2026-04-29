import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  type Dirent,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { InventoryWarning } from "../localInventory/types.js";

export type HuggingfaceRevisionScan = {
  revision: string;
  snapshotPath: string;
  refs: string[];
  fileCount: number;
  lastModifiedMs: number | null;
  warnings: InventoryWarning[];
};

export type HuggingfaceModelScan = {
  repoType: "model";
  repoId: string;
  cacheRoot: string;
  cacheDir: string;
  refs: Record<string, string>;
  revisions: HuggingfaceRevisionScan[];
  snapshotCount: number;
  blobCount: number;
  sizeBytes: number;
  warnings: InventoryWarning[];
};

export type ScanHuggingfaceCacheResult = {
  cacheRoot: string;
  models: HuggingfaceModelScan[];
  warnings: InventoryWarning[];
};

export function scanHuggingfaceCache(cacheRootInput: string): ScanHuggingfaceCacheResult {
  const cacheRoot = resolve(cacheRootInput);
  const warnings: InventoryWarning[] = [];
  const models: HuggingfaceModelScan[] = [];

  let entries: Dirent[];
  try {
    entries = readdirSync(cacheRoot, { withFileTypes: true });
  } catch (e) {
    throw new Error(`cannot read Hugging Face cache root ${cacheRoot}: ${messageOf(e)}`);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("models--")) continue;
    const parsed = parseModelCacheDirName(entry.name);
    if (!parsed) {
      warnings.push({
        code: "model_dir_malformed",
        message: `Malformed Hugging Face model cache directory: ${entry.name}`,
        path: join(cacheRoot, entry.name),
      });
      continue;
    }
    models.push(scanModelDir(cacheRoot, join(cacheRoot, entry.name), parsed.repoId));
  }

  return { cacheRoot, models, warnings };
}

export function parseModelCacheDirName(name: string): { repoId: string } | null {
  if (!name.startsWith("models--")) return null;
  const rest = name.slice("models--".length);
  const parts = rest.split("--").filter(Boolean);
  if (parts.length < 2) return null;
  return { repoId: parts.join("/") };
}

function scanModelDir(cacheRoot: string, cacheDir: string, repoId: string): HuggingfaceModelScan {
  const warnings: InventoryWarning[] = [];
  const refs = readRefs(join(cacheDir, "refs"), warnings);
  const revisions = readRevisions(join(cacheDir, "snapshots"), refs, warnings);
  const blobStats = readBlobStats(join(cacheDir, "blobs"), warnings);

  return {
    repoType: "model",
    repoId,
    cacheRoot,
    cacheDir,
    refs,
    revisions,
    snapshotCount: revisions.length,
    blobCount: blobStats.count,
    sizeBytes: blobStats.bytes,
    warnings,
  };
}

function readRefs(refsDir: string, warnings: InventoryWarning[]): Record<string, string> {
  const refs: Record<string, string> = {};
  if (!existsSync(refsDir)) return refs;
  let entries: Dirent[];
  try {
    entries = readdirSync(refsDir, { withFileTypes: true });
  } catch (e) {
    warnings.push({
      code: "refs_unreadable",
      message: `Cannot read refs directory: ${messageOf(e)}`,
      path: refsDir,
    });
    return refs;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const p = join(refsDir, entry.name);
    try {
      refs[entry.name] = readFileSync(p, "utf8").trim();
    } catch (e) {
      warnings.push({
        code: "ref_unreadable",
        message: `Cannot read ref ${entry.name}: ${messageOf(e)}`,
        path: p,
      });
    }
  }
  return refs;
}

function readRevisions(
  snapshotsDir: string,
  refs: Record<string, string>,
  modelWarnings: InventoryWarning[]
): HuggingfaceRevisionScan[] {
  if (!existsSync(snapshotsDir)) {
    modelWarnings.push({
      code: "snapshots_missing",
      message: "Model cache has no snapshots directory",
      path: snapshotsDir,
    });
    return [];
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(snapshotsDir, { withFileTypes: true });
  } catch (e) {
    modelWarnings.push({
      code: "snapshots_unreadable",
      message: `Cannot read snapshots directory: ${messageOf(e)}`,
      path: snapshotsDir,
    });
    return [];
  }

  const refNamesByRevision = new Map<string, string[]>();
  for (const [name, revision] of Object.entries(refs)) {
    const arr = refNamesByRevision.get(revision) ?? [];
    arr.push(name);
    refNamesByRevision.set(revision, arr);
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const snapshotPath = join(snapshotsDir, entry.name);
      const warnings: InventoryWarning[] = [];
      const walked = walkSnapshot(snapshotPath, warnings);
      return {
        revision: entry.name,
        snapshotPath,
        refs: refNamesByRevision.get(entry.name) ?? [],
        fileCount: walked.fileCount,
        lastModifiedMs: walked.lastModifiedMs,
        warnings,
      };
    });
}

function readBlobStats(blobsDir: string, warnings: InventoryWarning[]): { count: number; bytes: number } {
  if (!existsSync(blobsDir)) return { count: 0, bytes: 0 };
  let entries: Dirent[];
  try {
    entries = readdirSync(blobsDir, { withFileTypes: true });
  } catch (e) {
    warnings.push({
      code: "blobs_unreadable",
      message: `Cannot read blobs directory: ${messageOf(e)}`,
      path: blobsDir,
    });
    return { count: 0, bytes: 0 };
  }
  let count = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const p = join(blobsDir, entry.name);
    try {
      const st = statSync(p);
      count += 1;
      bytes += st.size;
    } catch (e) {
      warnings.push({
        code: "blob_stat_failed",
        message: `Cannot stat blob ${entry.name}: ${messageOf(e)}`,
        path: p,
      });
    }
  }
  return { count, bytes };
}

function walkSnapshot(
  snapshotPath: string,
  warnings: InventoryWarning[]
): { fileCount: number; lastModifiedMs: number | null } {
  let fileCount = 0;
  let lastModifiedMs: number | null = null;

  function visit(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      warnings.push({
        code: "snapshot_dir_unreadable",
        message: `Cannot read snapshot directory: ${messageOf(e)}`,
        path: dir,
      });
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      try {
        const lst = lstatSync(p);
        if (lst.isDirectory()) {
          visit(p);
          continue;
        }
        if (lst.isSymbolicLink()) {
          try {
            const target = resolve(dirname(p), readlinkSync(p));
            const st = statSync(target);
            if (st.isFile()) {
              fileCount += 1;
              lastModifiedMs = Math.max(lastModifiedMs ?? 0, Math.floor(st.mtimeMs));
            }
          } catch (e) {
            warnings.push({
              code: "snapshot_symlink_broken",
              message: `Broken snapshot link ${basename(p)}: ${messageOf(e)}`,
              path: p,
            });
          }
          continue;
        }
        if (lst.isFile()) {
          fileCount += 1;
          lastModifiedMs = Math.max(lastModifiedMs ?? 0, Math.floor(lst.mtimeMs));
        }
      } catch (e) {
        warnings.push({
          code: "snapshot_entry_stat_failed",
          message: `Cannot stat snapshot entry ${entry.name}: ${messageOf(e)}`,
          path: p,
        });
      }
    }
  }

  visit(snapshotPath);
  return { fileCount, lastModifiedMs };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
