import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { InventoryWarning } from "../localInventory/types.js";

export type LmStudioModelFormat = "gguf" | "mlx_safetensors" | "safetensors" | "mixed" | "unknown";
export type LmStudioFileKind = "weight" | "auxiliary";

export type LmStudioModelFileScan = {
  relPath: string;
  fileKind: LmStudioFileKind;
  format: string;
  sizeBytes: number;
  targetPath: string | null;
  isSymlink: boolean;
  lastModifiedMs: number | null;
  warnings: InventoryWarning[];
};

export type LmStudioModelScan = {
  publisher: string;
  modelName: string;
  modelKey: string;
  modelsRoot: string;
  modelDir: string;
  format: LmStudioModelFormat;
  files: LmStudioModelFileScan[];
  weightFileCount: number;
  auxiliaryFileCount: number;
  totalFileCount: number;
  totalSizeBytes: number;
  weightSizeBytes: number;
  primaryFile: string | null;
  configJson: string | null;
  lastModifiedMs: number | null;
  warnings: InventoryWarning[];
};

export type ScanLmStudioModelsResult = {
  modelsRoot: string;
  models: LmStudioModelScan[];
  warnings: InventoryWarning[];
};

export function scanLmStudioModels(modelsRootInput: string): ScanLmStudioModelsResult {
  const modelsRoot = resolve(modelsRootInput);
  const warnings: InventoryWarning[] = [];
  const models: LmStudioModelScan[] = [];

  let publishers: Dirent[];
  try {
    publishers = readdirSync(modelsRoot, { withFileTypes: true });
  } catch (e) {
    throw new Error(`cannot read LM Studio models root ${modelsRoot}: ${messageOf(e)}`);
  }

  for (const publisher of publishers) {
    if (!publisher.isDirectory()) continue;
    const publisherDir = join(modelsRoot, publisher.name);
    let entries: Dirent[];
    try {
      entries = readdirSync(publisherDir, { withFileTypes: true });
    } catch (e) {
      warnings.push({
        code: "publisher_dir_unreadable",
        message: `Cannot read LM Studio publisher directory ${publisher.name}: ${messageOf(e)}`,
        path: publisherDir,
      });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const model = scanModelDir(modelsRoot, publisher.name, entry.name, join(publisherDir, entry.name));
      if (model) models.push(model);
    }
  }

  return { modelsRoot, models, warnings };
}

function scanModelDir(
  modelsRoot: string,
  publisher: string,
  modelName: string,
  modelDir: string
): LmStudioModelScan | null {
  const warnings: InventoryWarning[] = [];
  const files: LmStudioModelFileScan[] = [];
  let totalFileCount = 0;
  let totalSizeBytes = 0;
  let lastModifiedMs: number | null = null;

  function visit(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      warnings.push({
        code: "model_dir_unreadable",
        message: `Cannot read LM Studio model directory: ${messageOf(e)}`,
        path: dir,
      });
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      try {
        const lst = lstatSync(path);
        if (lst.isDirectory()) {
          visit(path);
          continue;
        }
        if (lst.isSymbolicLink()) {
          const relPath = relative(modelDir, path);
          try {
            const target = resolve(dirname(path), readlinkSync(path));
            const st = statSync(target);
            if (st.isDirectory()) {
              warnings.push({
                code: "directory_symlink_skipped",
                message: `Directory symlink skipped: ${relPath}`,
                path,
              });
              continue;
            }
            if (st.isFile()) {
              totalFileCount++;
              totalSizeBytes += st.size;
              lastModifiedMs = Math.max(lastModifiedMs ?? 0, Math.floor(st.mtimeMs));
              pushInterestingFile(path, relPath, st.size, Math.floor(st.mtimeMs), target, true, files);
            }
          } catch (e) {
            warnings.push({
              code: "file_symlink_broken",
              message: `Broken file symlink ${relPath}: ${messageOf(e)}`,
              path,
            });
          }
          continue;
        }
        if (!lst.isFile()) continue;
        totalFileCount++;
        totalSizeBytes += lst.size;
        lastModifiedMs = Math.max(lastModifiedMs ?? 0, Math.floor(lst.mtimeMs));
        pushInterestingFile(path, relative(modelDir, path), lst.size, Math.floor(lst.mtimeMs), null, false, files);
      } catch (e) {
        warnings.push({
          code: "file_stat_failed",
          message: `Cannot stat LM Studio model entry ${entry.name}: ${messageOf(e)}`,
          path,
        });
      }
    }
  }

  visit(modelDir);

  const weightFiles = files.filter((f) => f.fileKind === "weight");
  const auxiliaryFiles = files.filter((f) => f.fileKind === "auxiliary");
  const configJson = readConfigJson(join(modelDir, "config.json"), warnings);
  if (totalFileCount === 0) {
    warnings.push({ code: "model_dir_empty", message: `LM Studio model directory is empty: ${publisher}/${modelName}`, path: modelDir });
  }
  if (weightFiles.length === 0) {
    warnings.push({
      code: "model_dir_no_weight_files",
      message: `LM Studio model directory has no recognized weight files: ${publisher}/${modelName}`,
      path: modelDir,
    });
  }
  if (weightFiles.length === 0 && !configJson) return null;

  const format = detectFormat(publisher, modelName, weightFiles);
  const primaryFile = [...weightFiles].sort((a, b) => b.sizeBytes - a.sizeBytes || a.relPath.localeCompare(b.relPath))[0]?.relPath ?? null;
  return {
    publisher,
    modelName,
    modelKey: `${publisher}/${modelName}`,
    modelsRoot,
    modelDir,
    format,
    files,
    weightFileCount: weightFiles.length,
    auxiliaryFileCount: auxiliaryFiles.length,
    totalFileCount,
    totalSizeBytes,
    weightSizeBytes: weightFiles.reduce((sum, f) => sum + f.sizeBytes, 0),
    primaryFile,
    configJson,
    lastModifiedMs,
    warnings,
  };
}

function pushInterestingFile(
  path: string,
  relPath: string,
  sizeBytes: number,
  lastModifiedMs: number,
  targetPath: string | null,
  isSymlink: boolean,
  files: LmStudioModelFileScan[]
): void {
  const kind = classifyFile(path);
  if (!kind) return;
  const warnings: InventoryWarning[] = isSymlink
    ? [{ code: "file_symlink", message: `File symlink counted via target: ${relPath}`, path }]
    : [];
  files.push({
    relPath,
    fileKind: kind.fileKind,
    format: kind.format,
    sizeBytes,
    targetPath,
    isSymlink,
    lastModifiedMs,
    warnings,
  });
}

function classifyFile(path: string): { fileKind: LmStudioFileKind; format: string } | null {
  const name = basename(path).toLowerCase();
  const ext = extname(name);
  if (ext === ".gguf") return { fileKind: name.startsWith("mmproj-") ? "auxiliary" : "weight", format: "gguf" };
  if (ext === ".safetensors") return { fileKind: "weight", format: "safetensors" };
  if (["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "processor_config.json", "preprocessor_config.json", "video_preprocessor_config.json", "chat_template.jinja", "model.safetensors.index.json"].includes(name)) {
    return { fileKind: "auxiliary", format: name };
  }
  return null;
}

function detectFormat(publisher: string, modelName: string, weightFiles: LmStudioModelFileScan[]): LmStudioModelFormat {
  const hasGguf = weightFiles.some((f) => f.format === "gguf");
  const hasSafetensors = weightFiles.some((f) => f.format === "safetensors");
  if (hasGguf && hasSafetensors) return "mixed";
  if (hasGguf) return "gguf";
  if (hasSafetensors) {
    const text = `${publisher}/${modelName}`.toLowerCase();
    return text.includes("mlx") ? "mlx_safetensors" : "safetensors";
  }
  return "unknown";
}

function readConfigJson(path: string, warnings: InventoryWarning[]): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    warnings.push({ code: "config_json_unreadable", message: `Cannot read config.json: ${messageOf(e)}`, path });
    return null;
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
