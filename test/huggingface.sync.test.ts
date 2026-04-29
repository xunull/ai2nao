import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { syncHuggingfaceModels } from "../src/huggingface/sync.js";
import { openDatabase } from "../src/store/open.js";

function writeModel(root: string, name = "models--org--repo") {
  const model = join(root, name);
  mkdirSync(join(model, "refs"), { recursive: true });
  mkdirSync(join(model, "blobs"), { recursive: true });
  mkdirSync(join(model, "snapshots", "abc123"), { recursive: true });
  writeFileSync(join(model, "refs", "main"), "abc123\n", "utf8");
  writeFileSync(join(model, "blobs", "blob-a"), "hello", "utf8");
  symlinkSync("../../blobs/blob-a", join(model, "snapshots", "abc123", "config.json"));
}

describe("syncHuggingfaceModels", () => {
  it("upserts models and revisions without duplicating rows", () => {
    const base = join(tmpdir(), `ai2nao-hf-sync-${Date.now()}`);
    const root = join(base, "hub");
    writeModel(root);
    const db = openDatabase(join(base, "idx.db"));
    try {
      const r1 = syncHuggingfaceModels(db, { root });
      expect(r1.status).toBe("success");
      expect(r1.inserted).toBe(1);

      const r2 = syncHuggingfaceModels(db, { root });
      expect(r2.inserted).toBe(0);
      expect(r2.updated).toBe(1);

      const modelCount = (db.prepare("SELECT COUNT(*) AS n FROM huggingface_models").get() as { n: number }).n;
      const revCount = (db.prepare("SELECT COUNT(*) AS n FROM huggingface_model_revisions").get() as { n: number }).n;
      expect(modelCount).toBe(1);
      expect(revCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("records partial runs for cache warnings and marks missing models", () => {
    const base = join(tmpdir(), `ai2nao-hf-partial-${Date.now()}`);
    const root = join(base, "hub");
    writeModel(root);
    const db = openDatabase(join(base, "idx.db"));
    try {
      syncHuggingfaceModels(db, { root });
      const model = join(root, "models--org--repo");
      symlinkSync("../../blobs/missing", join(model, "snapshots", "abc123", "bad.json"));

      const partial = syncHuggingfaceModels(db, { root });
      expect(partial.status).toBe("partial");
      expect(partial.warnings.some((w) => w.code === "snapshot_symlink_broken")).toBe(true);

      renameSync(model, join(root, "gone-repo"));
      const missing = syncHuggingfaceModels(db, { root });
      expect(missing.status).toBe("success");
      expect(missing.markedMissing).toBe(1);

      writeModel(root);
      const restored = syncHuggingfaceModels(db, { root });
      expect(restored.status).toBe("success");
      const row = db
        .prepare("SELECT missing_since FROM huggingface_models WHERE repo_id = 'org/repo'")
        .get() as { missing_since: string | null };
      expect(row.missing_since).toBeNull();
    } finally {
      db.close();
    }
  });

  it("records failed runs when the cache root cannot be read", () => {
    const base = join(tmpdir(), `ai2nao-hf-failed-${Date.now()}`);
    const db = openDatabase(join(base, "idx.db"));
    try {
      const result = syncHuggingfaceModels(db, { root: join(base, "missing-hub") });

      expect(result.ok).toBe(false);
      expect(result.status).toBe("failed");
      expect(result.errorSummary).toMatch(/cannot read Hugging Face cache root/);
      const run = db
        .prepare("SELECT status, error_summary FROM local_inventory_sync_runs WHERE source = 'huggingface'")
        .get() as { status: string; error_summary: string };
      expect(run.status).toBe("failed");
      expect(run.error_summary).toMatch(/cannot read Hugging Face cache root/);
    } finally {
      db.close();
    }
  });
});
