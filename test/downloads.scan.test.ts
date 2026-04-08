import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/open.js";
import { scanDownloads } from "../src/downloads/scan.js";
import { listDownloadsForDay } from "../src/downloads/queries.js";

describe("scanDownloads", () => {
  it("inserts new files and skips on second scan", () => {
    const base = join(tmpdir(), `ai2nao-dl-${Date.now()}`);
    const dl = join(base, "Downloads");
    mkdirSync(join(dl, "sub"), { recursive: true });
    writeFileSync(join(dl, "a.txt"), "hello", "utf8");
    writeFileSync(join(dl, "sub", "b.txt"), "world", "utf8");

    const dbPath = join(base, "idx.db");
    const db = openDatabase(dbPath);
    try {
      const r1 = scanDownloads(db, [dl]);
      expect(r1.inserted).toBe(2);
      expect(r1.skipped).toBe(0);
      expect(r1.errors).toEqual([]);

      const r2 = scanDownloads(db, [dl]);
      expect(r2.inserted).toBe(0);
      expect(r2.skipped).toBe(2);

      const anyDay = db
        .prepare(
          "SELECT calendar_day FROM download_files LIMIT 1"
        )
        .get() as { calendar_day: string } | undefined;
      expect(anyDay?.calendar_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (anyDay) {
        const rows = listDownloadsForDay(db, anyDay.calendar_day);
        expect(rows.length).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });
});
