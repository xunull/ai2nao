import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexStateDbPath } from "../src/codexHistory/paths.js";

/**
 * Codex keeps flip-flopping which copy of state_5.sqlite it actively writes:
 *  - 2026-06-18 (/investigate): it relocated its SQLite DBs INTO `~/.codex/sqlite/`,
 *    leaving the old top-level `~/.codex/state_5.sqlite` as a stale snapshot.
 *  - 2026-06-30 (/investigate): it had moved BACK to the top level by 06-19,
 *    freezing the `sqlite/` copy instead — so ~10 days of recent sessions
 *    vanished from the history list (page read the frozen relocated copy).
 *
 * Either location can be the stale one, so codexStateDbPath must pick the
 * freshest by mtime (counting the -wal sidecar) when both exist — never a
 * fixed location.
 */
describe("codexStateDbPath — picks the freshest state_5.sqlite", () => {
  function freshRoot(): string {
    return mkdtempSync(join(tmpdir(), "ai2nao-codex-paths-"));
  }

  function writeDb(path: string, mtimeSec: number): void {
    writeFileSync(path, "");
    utimesSync(path, mtimeSec, mtimeSec);
  }

  it("only relocated exists → relocated", () => {
    const root = freshRoot();
    mkdirSync(join(root, "sqlite"), { recursive: true });
    writeFileSync(join(root, "sqlite", "state_5.sqlite"), "");
    expect(codexStateDbPath(root)).toBe(join(root, "sqlite", "state_5.sqlite"));
  });

  it("only legacy exists → legacy", () => {
    const root = freshRoot();
    writeFileSync(join(root, "state_5.sqlite"), "");
    expect(codexStateDbPath(root)).toBe(join(root, "state_5.sqlite"));
  });

  it("neither exists → legacy path (resolver is total)", () => {
    const root = freshRoot();
    expect(codexStateDbPath(root)).toBe(join(root, "state_5.sqlite"));
  });

  // 2026-06-18 era: Codex moved INTO sqlite/, so the relocated copy is fresher.
  it("both exist, relocated is fresher → relocated", () => {
    const root = freshRoot();
    mkdirSync(join(root, "sqlite"), { recursive: true });
    writeDb(join(root, "state_5.sqlite"), 1_700_000_000); // older top-level
    writeDb(join(root, "sqlite", "state_5.sqlite"), 1_700_086_400); // newer
    expect(codexStateDbPath(root)).toBe(join(root, "sqlite", "state_5.sqlite"));
  });

  // 2026-06-30 regression: Codex moved BACK to the top level; sqlite/ froze.
  // Old "prefer relocated when it exists" read the frozen copy → recent
  // sessions disappeared. Must now pick the live legacy DB.
  it("both exist, legacy is fresher → legacy (the flip-back regression)", () => {
    const root = freshRoot();
    mkdirSync(join(root, "sqlite"), { recursive: true });
    writeDb(join(root, "sqlite", "state_5.sqlite"), 1_700_000_000); // frozen
    writeDb(join(root, "state_5.sqlite"), 1_700_864_000); // live, ~10 days newer
    expect(codexStateDbPath(root)).toBe(join(root, "state_5.sqlite"));
  });

  // A live write usually lands in the -wal first; the main .sqlite mtime lags.
  // Freshness must count the sidecar, or we'd misread which DB is current.
  it("freshness counts the -wal sidecar, not just the .sqlite file", () => {
    const root = freshRoot();
    mkdirSync(join(root, "sqlite"), { recursive: true });
    // relocated main file looks newest by itself...
    writeDb(join(root, "sqlite", "state_5.sqlite"), 1_700_500_000);
    // ...but legacy's WAL is very recent → legacy is actually the live DB.
    writeDb(join(root, "state_5.sqlite"), 1_700_000_000);
    writeDb(join(root, "state_5.sqlite-wal"), 1_700_900_000);
    expect(codexStateDbPath(root)).toBe(join(root, "state_5.sqlite"));
  });

  // -shm is touched by ANY reader (including our own readonly open), so it must
  // NOT count toward freshness — else a frozen DB we once read looks "live"
  // forever and we never switch to the actually-live copy.
  it("a freshly-touched -shm on the frozen DB does not win", () => {
    const root = freshRoot();
    mkdirSync(join(root, "sqlite"), { recursive: true });
    // relocated is frozen (old main + old wal) but its -shm was just touched
    writeDb(join(root, "sqlite", "state_5.sqlite"), 1_700_000_000);
    writeDb(join(root, "sqlite", "state_5.sqlite-wal"), 1_700_000_000);
    writeDb(join(root, "sqlite", "state_5.sqlite-shm"), 1_700_900_000); // reader noise
    // legacy is the live DB (newer than relocated's real write signals)
    writeDb(join(root, "state_5.sqlite"), 1_700_800_000);
    expect(codexStateDbPath(root)).toBe(join(root, "state_5.sqlite"));
  });
});
