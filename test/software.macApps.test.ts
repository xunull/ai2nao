import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { syncMacApps } from "../src/software/macApps/sync.js";
import { openDatabase } from "../src/store/open.js";

describe("syncMacApps", () => {
  it("upserts app bundles, records warnings, and marks missing by scanned root", async () => {
    const base = join(tmpdir(), `ai2nao-apps-${Date.now()}`);
    const root = join(base, "Applications");
    const app = join(root, "Example.app");
    const bad = join(root, "Broken.app");
    mkdirSync(join(app, "Contents"), { recursive: true });
    mkdirSync(join(bad, "Contents"), { recursive: true });

    const db = openDatabase(join(base, "idx.db"));
    try {
      const readInfo = async (path: string) => {
        if (path.includes("Broken.app")) throw new Error("bad plist");
        return {
          CFBundleIdentifier: "com.example.app",
          CFBundleDisplayName: "Example",
          CFBundleShortVersionString: "1.2.3",
        };
      };

      const r1 = await syncMacApps(db, { roots: [root], readInfo, platformSupported: true });
      expect(r1.status).toBe("partial");
      expect(r1.inserted).toBe(1);
      expect(r1.warnings).toHaveLength(1);

      const r2 = await syncMacApps(db, { roots: [root], readInfo, platformSupported: true });
      expect(r2.inserted).toBe(0);
      expect(r2.updated).toBe(1);

      const missing = await syncMacApps(db, {
        roots: [root],
        platformSupported: true,
        readInfo: async () => {
          throw new Error("everything vanished");
        },
      });
      expect(missing.markedMissing).toBe(1);
      const row = db
        .prepare("SELECT missing_since FROM mac_apps WHERE path = ?")
        .get(app) as { missing_since: string | null };
      expect(row.missing_since).toMatch(/^\d{4}-/);
    } finally {
      db.close();
    }
  });
});
