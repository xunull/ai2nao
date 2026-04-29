import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type HuggingfaceRootResolution = {
  cacheRoot: string;
  source: "explicit" | "HF_HUB_CACHE" | "HF_HOME" | "default";
};

export function expandHomePath(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return raw;
}

export function defaultHuggingfaceHome(): string {
  return join(homedir(), ".cache", "huggingface");
}

export function defaultHuggingfaceHubCache(): string {
  return join(defaultHuggingfaceHome(), "hub");
}

export function resolveHuggingfaceHubCacheRoot(
  raw?: string,
  env: NodeJS.ProcessEnv = process.env
): HuggingfaceRootResolution {
  const explicit = cleanRoot(raw);
  if (explicit) return { cacheRoot: explicit, source: "explicit" };

  const hub = cleanRoot(env.HF_HUB_CACHE);
  if (hub) return { cacheRoot: hub, source: "HF_HUB_CACHE" };

  const home = cleanRoot(env.HF_HOME);
  if (home) return { cacheRoot: join(home, "hub"), source: "HF_HOME" };

  return { cacheRoot: defaultHuggingfaceHubCache(), source: "default" };
}

function cleanRoot(raw: string | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const expanded = expandHomePath(t);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(expanded);
}
