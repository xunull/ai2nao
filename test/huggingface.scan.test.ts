import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { scanHuggingfaceCache } from "../src/huggingface/scan.js";

describe("scanHuggingfaceCache", () => {
  it("parses model cache dirs, refs, revisions, and deduplicated blob bytes", () => {
    const root = join(tmpdir(), `ai2nao-hf-scan-${Date.now()}`);
    const model = join(root, "models--org--repo");
    mkdirSync(join(model, "refs"), { recursive: true });
    mkdirSync(join(model, "blobs"), { recursive: true });
    mkdirSync(join(model, "snapshots", "abc123"), { recursive: true });
    mkdirSync(join(root, "datasets--org--data"), { recursive: true });
    writeFileSync(join(model, "refs", "main"), "abc123\n", "utf8");
    writeFileSync(join(model, "blobs", "blob-a"), "hello", "utf8");
    symlinkSync("../../blobs/blob-a", join(model, "snapshots", "abc123", "config.json"));

    const result = scanHuggingfaceCache(root);

    expect(result.models).toHaveLength(1);
    expect(result.models[0].repoId).toBe("org/repo");
    expect(result.models[0].refs).toEqual({ main: "abc123" });
    expect(result.models[0].sizeBytes).toBe(5);
    expect(result.models[0].blobCount).toBe(1);
    expect(result.models[0].revisions[0].refs).toEqual(["main"]);
    expect(result.models[0].revisions[0].fileCount).toBe(1);
  });

  it("records warnings for broken snapshot links", () => {
    const root = join(tmpdir(), `ai2nao-hf-broken-${Date.now()}`);
    const model = join(root, "models--org--repo");
    mkdirSync(join(model, "snapshots", "abc123"), { recursive: true });
    symlinkSync("../../blobs/missing", join(model, "snapshots", "abc123", "config.json"));

    const result = scanHuggingfaceCache(root);

    expect(result.models[0].revisions[0].warnings.some((w) => w.code === "snapshot_symlink_broken")).toBe(true);
  });

  it("throws for unreadable roots and records malformed cache dirs", () => {
    expect(() => scanHuggingfaceCache(join(tmpdir(), `ai2nao-hf-missing-${Date.now()}`))).toThrow(
      /cannot read Hugging Face cache root/
    );

    const root = join(tmpdir(), `ai2nao-hf-malformed-${Date.now()}`);
    mkdirSync(join(root, "models--broken"), { recursive: true });

    const result = scanHuggingfaceCache(root);

    expect(result.models).toHaveLength(0);
    expect(result.warnings.some((w) => w.code === "model_dir_malformed")).toBe(true);
  });

  it("walks nested regular files inside snapshots", () => {
    const root = join(tmpdir(), `ai2nao-hf-regular-${Date.now()}`);
    const model = join(root, "models--org--repo");
    mkdirSync(join(model, "snapshots", "abc123", "nested"), { recursive: true });
    writeFileSync(join(model, "snapshots", "abc123", "nested", "tokenizer.json"), "{}", "utf8");

    const result = scanHuggingfaceCache(root);

    expect(result.models[0].revisions[0].fileCount).toBe(1);
    expect(result.models[0].revisions[0].lastModifiedMs).toEqual(expect.any(Number));
  });
});
