import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveLmStudioModelsRoot } from "../src/lmstudio/roots.js";

describe("resolveLmStudioModelsRoot", () => {
  it("prefers explicit and env roots before settings", () => {
    expect(resolveLmStudioModelsRoot("/tmp/a", {}, {}).source).toBe("explicit");
    expect(resolveLmStudioModelsRoot(undefined, { LMSTUDIO_MODELS_DIR: "/tmp/b" }, {}).source).toBe("LMSTUDIO_MODELS_DIR");
  });

  it("uses app settings and reports conflicting home settings", () => {
    const base = join(tmpdir(), `ai2nao-lm-roots-${Date.now()}`);
    const appRoot = join(base, "app-models");
    const homeRoot = join(base, "home-models");
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });
    const appSettings = join(base, "app-settings.json");
    const homeSettings = join(base, "home-settings.json");
    writeFileSync(appSettings, JSON.stringify({ downloadsFolder: appRoot }), "utf8");
    writeFileSync(homeSettings, JSON.stringify({ downloadsFolder: homeRoot }), "utf8");

    const resolved = resolveLmStudioModelsRoot(undefined, {}, { appSettingsPath: appSettings, homeSettingsPath: homeSettings });

    expect(resolved.modelsRoot).toBe(resolve(appRoot));
    expect(resolved.source).toBe("app_settings");
    expect(resolved.alternativeRoots[0].modelsRoot).toBe(resolve(homeRoot));
    expect(resolved.warnings.some((w) => w.code === "settings_roots_conflict")).toBe(true);
  });

  it("falls back to default and reports broken settings", () => {
    const base = join(tmpdir(), `ai2nao-lm-bad-settings-${Date.now()}`);
    const appSettings = join(base, "bad.json");
    mkdirSync(base, { recursive: true });
    writeFileSync(appSettings, "{", "utf8");

    const resolved = resolveLmStudioModelsRoot(undefined, {}, { appSettingsPath: appSettings, homeSettingsPath: join(base, "missing.json") });

    expect(resolved.source).toBe("default");
    expect(resolved.warnings.some((w) => w.code === "settings_json_unreadable")).toBe(true);
  });
});
