import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { syncLmStudioModels } from "../src/lmstudio/sync.js";
import { openDatabase } from "../src/store/open.js";

function writeModel(root: string) {
  const dir = join(root, "org", "repo-GGUF");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "repo-Q4_K_M.gguf"), "hello", "utf8");
  writeFileSync(join(dir, "mmproj-repo.gguf"), "mm", "utf8");
}

describe("syncLmStudioModels", () => {
  it("upserts models and key file rows without duplicating records", () => {
    const base = join(tmpdir(), `ai2nao-lm-sync-${Date.now()}`);
    const root = join(base, "models");
    writeModel(root);
    const db = openDatabase(join(base, "idx.db"));
    try {
      const r1 = syncLmStudioModels(db, { root });
      expect(r1.status).toBe("success");
      expect(r1.inserted).toBe(1);

      const r2 = syncLmStudioModels(db, { root });
      expect(r2.inserted).toBe(0);
      expect(r2.updated).toBe(1);

      const modelCount = (db.prepare("SELECT COUNT(*) AS n FROM lmstudio_models").get() as { n: number }).n;
      const fileCount = (db.prepare("SELECT COUNT(*) AS n FROM lmstudio_model_files").get() as { n: number }).n;
      expect(modelCount).toBe(1);
      expect(fileCount).toBe(2);
    } finally {
      db.close();
    }
  });

  it("marks missing models and records failed runs", () => {
    const base = join(tmpdir(), `ai2nao-lm-missing-${Date.now()}`);
    const root = join(base, "models");
    writeModel(root);
    const db = openDatabase(join(base, "idx.db"));
    try {
      syncLmStudioModels(db, { root });
      renameSync(join(root, "org", "repo-GGUF"), join(root, "org", "gone"));
      const missing = syncLmStudioModels(db, { root });
      expect(missing.markedMissing).toBe(1);

      const failed = syncLmStudioModels(db, { root: join(base, "nope") });
      expect(failed.ok).toBe(false);
      expect(failed.status).toBe("failed");
      const run = db
        .prepare("SELECT status FROM local_inventory_sync_runs WHERE source = 'lmstudio' ORDER BY id DESC LIMIT 1")
        .get() as { status: string };
      expect(run.status).toBe("failed");
    } finally {
      db.close();
    }
  });
});
