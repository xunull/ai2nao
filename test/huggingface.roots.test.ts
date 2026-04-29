import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHuggingfaceHubCacheRoot } from "../src/huggingface/roots.js";

describe("resolveHuggingfaceHubCacheRoot", () => {
  it("uses explicit root before env values", () => {
    const r = resolveHuggingfaceHubCacheRoot("~/hf/hub", {
      HF_HUB_CACHE: "/env/hub",
      HF_HOME: "/env/home",
    });
    expect(r).toEqual({
      cacheRoot: join(homedir(), "hf", "hub"),
      source: "explicit",
    });
  });

  it("uses HF_HUB_CACHE before HF_HOME", () => {
    const r = resolveHuggingfaceHubCacheRoot(undefined, {
      HF_HUB_CACHE: "/env/hub",
      HF_HOME: "/env/home",
    });
    expect(r).toEqual({ cacheRoot: "/env/hub", source: "HF_HUB_CACHE" });
  });

  it("uses HF_HOME/hub before the default root", () => {
    const r = resolveHuggingfaceHubCacheRoot(undefined, { HF_HOME: "/env/home" });
    expect(r).toEqual({ cacheRoot: "/env/home/hub", source: "HF_HOME" });
  });

  it("falls back to the default Hub cache root", () => {
    const r = resolveHuggingfaceHubCacheRoot(undefined, {});
    expect(r).toEqual({
      cacheRoot: resolve(join(homedir(), ".cache", "huggingface", "hub")),
      source: "default",
    });
  });
});
