import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexStateDbPath } from "../src/codexHistory/paths.js";

/**
 * Regression (2026-06-18 /investigate): newer Codex relocated its SQLite
 * databases into `~/.codex/sqlite/`, leaving the old top-level
 * `~/.codex/state_5.sqlite` as a STALE snapshot. ai2nao read the stale copy,
 * so resumed sessions kept their pre-relocation `last_updated_at` and recent
 * Codex token usage "disappeared" from recent-days views.
 *
 * codexStateDbPath must prefer the relocated DB when it exists, and fall back
 * to the legacy path for older installs.
 */
describe("codexStateDbPath — relocated sqlite/ dir", () => {
  function freshRoot(): string {
    const base = mkdtempSync(join(tmpdir(), "ai2nao-codex-paths-"));
    return base;
  }

  it("prefers ~/.codex/sqlite/state_5.sqlite when it exists", () => {
    const root = freshRoot();
    mkdirSync(join(root, "sqlite"), { recursive: true });
    writeFileSync(join(root, "sqlite", "state_5.sqlite"), "");
    // legacy file also present (stale leftover) — must NOT be chosen
    writeFileSync(join(root, "state_5.sqlite"), "");

    expect(codexStateDbPath(root)).toBe(join(root, "sqlite", "state_5.sqlite"));
  });

  it("falls back to legacy ~/.codex/state_5.sqlite when sqlite/ absent", () => {
    const root = freshRoot();
    writeFileSync(join(root, "state_5.sqlite"), "");

    expect(codexStateDbPath(root)).toBe(join(root, "state_5.sqlite"));
  });

  it("returns the legacy path when neither exists (resolver is total)", () => {
    const root = freshRoot();
    // no files at all — still returns a concrete path (caller handles ENOENT)
    expect(codexStateDbPath(root)).toBe(join(root, "state_5.sqlite"));
  });
});
