import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { copyVscodeStateSnapshot, removeVscodeSnapshot, VscodeSourceMissingError } from "../src/vscode/snapshot.js";

describe("VS Code state snapshot", () => {
  it("copies the database plus WAL and SHM companions", () => {
    const base = join(tmpdir(), `ai2nao-vscode-snapshot-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    const source = join(base, "state.vscdb");
    writeFileSync(source, "db");
    writeFileSync(`${source}-wal`, "wal");
    writeFileSync(`${source}-shm`, "shm");

    const snapshot = copyVscodeStateSnapshot(source);
    try {
      expect(existsSync(snapshot.dbPath)).toBe(true);
      expect(existsSync(`${snapshot.dbPath}-wal`)).toBe(true);
      expect(existsSync(`${snapshot.dbPath}-shm`)).toBe(true);
      expect(snapshot.copiedWal).toBe(true);
      expect(snapshot.copiedShm).toBe(true);
    } finally {
      removeVscodeSnapshot(snapshot);
    }
  });

  it("copies db-only snapshots", () => {
    const base = join(tmpdir(), `ai2nao-vscode-snapshot-db-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    const source = join(base, "state.vscdb");
    writeFileSync(source, "db");

    const snapshot = copyVscodeStateSnapshot(source);
    try {
      expect(snapshot.copiedWal).toBe(false);
      expect(snapshot.copiedShm).toBe(false);
      expect(existsSync(snapshot.dbPath)).toBe(true);
    } finally {
      removeVscodeSnapshot(snapshot);
    }
  });

  it("throws a typed error when the source is missing", () => {
    expect(() => copyVscodeStateSnapshot(join(tmpdir(), "missing-state.vscdb"))).toThrow(
      VscodeSourceMissingError
    );
  });
});
