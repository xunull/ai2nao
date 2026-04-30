import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { InventoryWarning } from "../localInventory/types.js";

export type LmStudioRootSource =
  | "explicit"
  | "LMSTUDIO_MODELS_DIR"
  | "app_settings"
  | "home_settings"
  | "default";

export type LmStudioRootAlternative = {
  source: Exclude<LmStudioRootSource, "explicit" | "LMSTUDIO_MODELS_DIR" | "default">;
  modelsRoot: string;
  settingsPath: string;
};

export type LmStudioRootResolution = {
  modelsRoot: string;
  source: LmStudioRootSource;
  settingsPath: string | null;
  alternativeRoots: LmStudioRootAlternative[];
  warnings: InventoryWarning[];
};

export function defaultLmStudioModelsRoot(): string {
  return join(homedir(), ".lmstudio", "models");
}

export function defaultLmStudioAppSettingsPath(): string {
  return join(homedir(), "Library", "Application Support", "LM Studio", "settings.json");
}

export function defaultLmStudioHomeSettingsPath(): string {
  return join(homedir(), ".lmstudio", "settings.json");
}

export function resolveLmStudioModelsRoot(
  raw?: string,
  env: NodeJS.ProcessEnv = process.env,
  paths: { appSettingsPath?: string; homeSettingsPath?: string } = {}
): LmStudioRootResolution {
  const explicit = cleanRoot(raw);
  if (explicit) {
    return {
      modelsRoot: explicit,
      source: "explicit",
      settingsPath: null,
      alternativeRoots: [],
      warnings: rootWarnings(explicit),
    };
  }

  const fromEnv = cleanRoot(env.LMSTUDIO_MODELS_DIR);
  if (fromEnv) {
    return {
      modelsRoot: fromEnv,
      source: "LMSTUDIO_MODELS_DIR",
      settingsPath: null,
      alternativeRoots: [],
      warnings: rootWarnings(fromEnv),
    };
  }

  const warnings: InventoryWarning[] = [];
  const app = readSettingsRoot(paths.appSettingsPath ?? defaultLmStudioAppSettingsPath(), "app_settings", warnings);
  const home = readSettingsRoot(paths.homeSettingsPath ?? defaultLmStudioHomeSettingsPath(), "home_settings", warnings);
  const chosen = app ?? home;
  if (chosen) {
    const alternatives = [app, home].filter(
      (r): r is NonNullable<typeof r> => !!r && r.modelsRoot !== chosen.modelsRoot
    );
    if (alternatives.length > 0) {
      warnings.push({
        code: "settings_roots_conflict",
        message: `LM Studio settings disagree; using ${chosen.modelsRoot}`,
        path: chosen.settingsPath,
      });
    }
    return {
      modelsRoot: chosen.modelsRoot,
      source: chosen.source,
      settingsPath: chosen.settingsPath,
      alternativeRoots: alternatives,
      warnings: [...warnings, ...rootWarnings(chosen.modelsRoot)],
    };
  }

  const fallback = defaultLmStudioModelsRoot();
  return {
    modelsRoot: fallback,
    source: "default",
    settingsPath: null,
    alternativeRoots: [],
    warnings: [...warnings, ...rootWarnings(fallback)],
  };
}

function readSettingsRoot(
  settingsPath: string,
  source: "app_settings" | "home_settings",
  warnings: InventoryWarning[]
): { source: "app_settings" | "home_settings"; modelsRoot: string; settingsPath: string } | null {
  if (!existsSync(settingsPath)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (e) {
    warnings.push({
      code: "settings_json_unreadable",
      message: `Cannot read LM Studio settings: ${messageOf(e)}`,
      path: settingsPath,
    });
    return null;
  }
  const folder = parsed && typeof parsed === "object" ? (parsed as { downloadsFolder?: unknown }).downloadsFolder : undefined;
  if (typeof folder !== "string" || !folder.trim()) {
    warnings.push({
      code: "downloads_folder_missing",
      message: `LM Studio settings has no downloadsFolder string: ${settingsPath}`,
      path: settingsPath,
    });
    return null;
  }
  return { source, modelsRoot: cleanRoot(folder) ?? resolve(folder), settingsPath };
}

function rootWarnings(modelsRoot: string): InventoryWarning[] {
  return existsSync(modelsRoot)
    ? []
    : [{ code: "models_root_missing", message: `LM Studio models root does not exist: ${modelsRoot}`, path: modelsRoot }];
}

function cleanRoot(raw: string | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const expanded = t === "~" ? homedir() : t.startsWith("~/") ? join(homedir(), t.slice(2)) : t;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(expanded);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
