import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { scanLmStudioModels } from "../src/lmstudio/scan.js";

describe("scanLmStudioModels", () => {
  it("detects GGUF weights, mmproj auxiliary files, and symlinked files", () => {
    const base = join(tmpdir(), `ai2nao-lm-scan-${Date.now()}`);
    const root = join(base, "models");
    const dir = join(root, "org", "repo-GGUF");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "repo-Q4_K_M.gguf"), "12345", "utf8");
    writeFileSync(join(dir, "mmproj-repo.gguf"), "12", "utf8");
    const external = join(base, "external.gguf");
    writeFileSync(external, "123456789", "utf8");
    symlinkSync(external, join(dir, "linked.gguf"));

    const result = scanLmStudioModels(root);

    expect(result.models).toHaveLength(1);
    expect(result.models[0].modelKey).toBe("org/repo-GGUF");
    expect(result.models[0].format).toBe("gguf");
    expect(result.models[0].weightFileCount).toBe(2);
    expect(result.models[0].auxiliaryFileCount).toBe(1);
    expect(result.models[0].files.some((f) => f.isSymlink && f.sizeBytes === 9)).toBe(true);
  });

  it("skips directory symlinks and records a warning", () => {
    const base = join(tmpdir(), `ai2nao-lm-dirlink-${Date.now()}`);
    const root = join(base, "models");
    const dir = join(root, "org", "repo");
    const externalDir = join(base, "outside");
    mkdirSync(dir, { recursive: true });
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(externalDir, "outside.gguf"), "big", "utf8");
    symlinkSync(externalDir, join(dir, "outside"));
    writeFileSync(join(dir, "model.gguf"), "ok", "utf8");

    const result = scanLmStudioModels(root);

    expect(result.models[0].files.some((f) => f.relPath.includes("outside"))).toBe(false);
    expect(result.models[0].warnings.some((w) => w.code === "directory_symlink_skipped")).toBe(true);
  });

  it("detects MLX safetensors models", () => {
    const root = join(tmpdir(), `ai2nao-lm-mlx-${Date.now()}`, "models");
    const dir = join(root, "mlx-community", "Qwen-MLX-4bit");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model-00001-of-00002.safetensors"), "a", "utf8");
    writeFileSync(join(dir, "model-00002-of-00002.safetensors"), "b", "utf8");
    writeFileSync(join(dir, "config.json"), "{}", "utf8");

    const result = scanLmStudioModels(root);

    expect(result.models[0].format).toBe("mlx_safetensors");
    expect(result.models[0].weightFileCount).toBe(2);
  });
});
