import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export type VscodeSnapshot = {
  dir: string;
  dbPath: string;
  copiedWal: boolean;
  copiedShm: boolean;
};

export class VscodeSourceMissingError extends Error {
  constructor(path: string) {
    super(`VS Code state database not found: ${path}`);
    this.name = "VscodeSourceMissingError";
  }
}

export class VscodeSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VscodeSnapshotError";
  }
}

export function copyVscodeStateSnapshot(sourcePath: string): VscodeSnapshot {
  if (!existsSync(sourcePath)) throw new VscodeSourceMissingError(sourcePath);
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-vscode-"));
  const dbPath = join(dir, basename(sourcePath));
  try {
    copyFileSync(sourcePath, dbPath);
    const wal = `${sourcePath}-wal`;
    const shm = `${sourcePath}-shm`;
    let copiedWal = false;
    let copiedShm = false;
    if (existsSync(wal)) {
      copyFileSync(wal, `${dbPath}-wal`);
      copiedWal = true;
    }
    if (existsSync(shm)) {
      copyFileSync(shm, `${dbPath}-shm`);
      copiedShm = true;
    }
    return { dir, dbPath, copiedWal, copiedShm };
  } catch (e) {
    removeVscodeSnapshot({ dir });
    throw new VscodeSnapshotError(e instanceof Error ? e.message : String(e));
  }
}

export function removeVscodeSnapshot(snapshot: Pick<VscodeSnapshot, "dir"> | null): void {
  if (!snapshot) return;
  try {
    rmSync(snapshot.dir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup */
  }
}
