import { describe, expect, it } from "vitest";
import {
  computeProjectLastActive,
  type ProjectSessionTime,
} from "../src/claudeCodeHistory/projectLastActive.js";
import type { ClaudeProjectSessionFile } from "../src/claudeCodeHistory/discover.js";

const iso = (ms: number) => new Date(ms).toISOString();

function file(filePath: string, mtimeMs: number, size: number): ClaudeProjectSessionFile {
  return { filePath, mtimeMs, size };
}

describe("computeProjectLastActive", () => {
  it("returns null when the project has no session files", () => {
    expect(computeProjectLastActive([], new Map())).toBeNull();
  });

  it("falls back to current file mtime when the token DB has no row (cold table)", () => {
    const files = [file("/a.jsonl", 1_700_000_000_000, 100)];
    expect(computeProjectLastActive(files, new Map())).toBe(iso(1_700_000_000_000));
  });

  it("orders correctly from mtime alone when the whole table is cold", () => {
    const older = file("/old.jsonl", 1_700_000_000_000, 100);
    const newer = file("/new.jsonl", 1_700_000_500_000, 100);
    // max wins
    expect(computeProjectLastActive([older, newer], new Map())).toBe(
      iso(1_700_000_500_000)
    );
  });

  it("CRITICAL: trusts DB last_updated_at when size matches even though disk mtime is a float and the stored mtime is a truncated int", () => {
    // Disk mtime is a float; DB stores Math.trunc(mtime). A raw `===` would never
    // match — but the rule keys on size, so this trap cannot degrade C into A.
    const files = [file("/a.jsonl", 1_700_000_000_123.456, 2048)];
    const byPath = new Map<string, ProjectSessionTime>([
      [
        "/a.jsonl",
        {
          lastUpdatedAt: "2026-06-20T10:00:00.000Z",
          fileMtimeMs: 1_700_000_000_123, // Math.trunc of the disk value
          fileSizeBytes: 2048,
        },
      ],
    ]);
    expect(computeProjectLastActive(files, byPath)).toBe("2026-06-20T10:00:00.000Z");
  });

  it("trusts DB time on pure mtime drift (mtime bumped, size unchanged)", () => {
    // iCloud/copy bumped mtime far into the future, but content (size) is unchanged.
    const driftedMtime = 1_900_000_000_000;
    const files = [file("/a.jsonl", driftedMtime, 2048)];
    const byPath = new Map<string, ProjectSessionTime>([
      [
        "/a.jsonl",
        {
          lastUpdatedAt: "2026-06-20T10:00:00.000Z",
          fileMtimeMs: 1_700_000_000_000,
          fileSizeBytes: 2048,
        },
      ],
    ]);
    // Must NOT use the drifted mtime.
    expect(computeProjectLastActive(files, byPath)).toBe("2026-06-20T10:00:00.000Z");
  });

  it("uses current mtime when size changed (new messages appended since sync)", () => {
    const freshMtime = 1_700_000_900_000;
    const files = [file("/a.jsonl", freshMtime, 4096)]; // grew from 2048
    const byPath = new Map<string, ProjectSessionTime>([
      [
        "/a.jsonl",
        {
          lastUpdatedAt: "2026-06-20T10:00:00.000Z",
          fileMtimeMs: 1_700_000_000_000,
          fileSizeBytes: 2048, // stale size
        },
      ],
    ]);
    expect(computeProjectLastActive(files, byPath)).toBe(iso(freshMtime));
  });

  it("takes the max across a mix of DB-trusted and mtime-fallback sessions", () => {
    const files = [
      file("/clean.jsonl", 1_700_000_000_000, 100), // DB row, size match -> DB time
      file("/fresh.jsonl", 1_700_000_900_000, 4096), // no DB row -> current mtime (newer)
    ];
    const byPath = new Map<string, ProjectSessionTime>([
      [
        "/clean.jsonl",
        {
          lastUpdatedAt: iso(1_700_000_000_000), // older than /fresh's mtime
          fileMtimeMs: 1_700_000_000_000,
          fileSizeBytes: 100,
        },
      ],
    ]);
    // /fresh.jsonl (no DB row, newer mtime) wins via the mtime fallback.
    expect(computeProjectLastActive(files, byPath)).toBe(iso(1_700_000_900_000));
  });
});
