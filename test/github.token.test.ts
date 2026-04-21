import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _githubConfigPathForTest,
  githubTokenStatus,
  loadGithubToken,
  parseGithubConfigJson,
  writeGithubConfig,
} from "../src/github/config.js";

/**
 * 隔离用：每个测试改 `AI2NAO_GITHUB_CONFIG` 指向 tmpdir 下的唯一路径，
 * 并清掉 `GITHUB_TOKEN`，避免主机环境污染结果。
 */
function freshTmpPath(label: string): string {
  return join(tmpdir(), `ai2nao-ghtok-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

const ORIGINAL_ENV = {
  token: process.env.GITHUB_TOKEN,
  cfg: process.env.AI2NAO_GITHUB_CONFIG,
};

beforeEach(() => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.AI2NAO_GITHUB_CONFIG;
});

afterEach(() => {
  if (ORIGINAL_ENV.token !== undefined) process.env.GITHUB_TOKEN = ORIGINAL_ENV.token;
  else delete process.env.GITHUB_TOKEN;
  if (ORIGINAL_ENV.cfg !== undefined) process.env.AI2NAO_GITHUB_CONFIG = ORIGINAL_ENV.cfg;
  else delete process.env.AI2NAO_GITHUB_CONFIG;
});

describe("parseGithubConfigJson", () => {
  it("accepts minimal {token}", () => {
    expect(parseGithubConfigJson('{"token":"ghp_x"}')).toEqual({ token: "ghp_x" });
  });

  it("keeps username and apiBase when present", () => {
    const cfg = parseGithubConfigJson(
      '{"token":"ghp_x","username":"alice","apiBase":"https://ghes.example.com/api/v3"}'
    );
    expect(cfg).toEqual({
      token: "ghp_x",
      username: "alice",
      apiBase: "https://ghes.example.com/api/v3",
    });
  });

  it("rejects empty or missing token", () => {
    expect(parseGithubConfigJson('{"token":""}')).toBeNull();
    expect(parseGithubConfigJson('{"token":"   "}')).toBeNull();
    expect(parseGithubConfigJson("{}")).toBeNull();
  });

  it("rejects non-object root and malformed json", () => {
    expect(parseGithubConfigJson("[]")).toBeNull();
    expect(parseGithubConfigJson("not json")).toBeNull();
    expect(parseGithubConfigJson("null")).toBeNull();
  });
});

describe("loadGithubToken", () => {
  it("prefers GITHUB_TOKEN env over file", () => {
    const path = freshTmpPath("env-wins");
    process.env.AI2NAO_GITHUB_CONFIG = path;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, '{"token":"from_file"}', "utf8");
    chmodSync(path, 0o600);
    process.env.GITHUB_TOKEN = "  from_env  ";
    const out = loadGithubToken();
    expect(out).not.toBeNull();
    expect(out!.source).toBe("env");
    expect(out!.token).toBe("from_env");
  });

  it("falls back to file when env is empty", () => {
    const path = freshTmpPath("file-fallback");
    process.env.AI2NAO_GITHUB_CONFIG = path;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, '{"token":"ghp_file","apiBase":"https://api.example.com"}', "utf8");
    chmodSync(path, 0o600);
    const out = loadGithubToken();
    expect(out?.source).toBe("file");
    expect(out?.token).toBe("ghp_file");
    expect(out?.config.apiBase).toBe("https://api.example.com");
  });

  it("returns null when neither env nor file is configured", () => {
    const path = freshTmpPath("nothing");
    process.env.AI2NAO_GITHUB_CONFIG = path;
    expect(loadGithubToken()).toBeNull();
  });

  it("returns null for corrupt JSON without throwing", () => {
    const path = freshTmpPath("bad-json");
    process.env.AI2NAO_GITHUB_CONFIG = path;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{ not json }", "utf8");
    chmodSync(path, 0o600);
    expect(loadGithubToken()).toBeNull();
  });

  it("warns on group/other-readable file but still loads", () => {
    const path = freshTmpPath("insecure");
    process.env.AI2NAO_GITHUB_CONFIG = path;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, '{"token":"ghp_loose"}', "utf8");
    chmodSync(path, 0o644);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = loadGithubToken();
      expect(out?.token).toBe("ghp_loose");
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("chmod 0600");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("writeGithubConfig", () => {
  it("writes JSON and chmods 0600", () => {
    const path = freshTmpPath("write");
    writeGithubConfig({ token: "ghp_new" }, path);
    const raw = readFileSync(path, "utf8");
    expect(JSON.parse(raw)).toEqual({ token: "ghp_new" });
    if (process.platform !== "win32") {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("uses env-derived path when no explicit path given", () => {
    const path = freshTmpPath("env-path");
    process.env.AI2NAO_GITHUB_CONFIG = path;
    writeGithubConfig({ token: "ghp_via_env" });
    expect(_githubConfigPathForTest()).toBe(path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ token: "ghp_via_env" });
  });
});

describe("githubTokenStatus", () => {
  it("reports env source without touching disk", () => {
    const path = freshTmpPath("status-env");
    process.env.AI2NAO_GITHUB_CONFIG = path;
    process.env.GITHUB_TOKEN = "ghp_envonly";
    const st = githubTokenStatus();
    expect(st.configured).toBe(true);
    expect(st.source).toBe("env");
    expect(st.insecureFilePermissions).toBe(false);
  });

  it("reports unconfigured when env empty and file missing", () => {
    const path = freshTmpPath("status-none");
    process.env.AI2NAO_GITHUB_CONFIG = path;
    const st = githubTokenStatus();
    expect(st.configured).toBe(false);
    expect(st.source).toBeNull();
  });

  it("flags insecureFilePermissions when file is group-readable", () => {
    const path = freshTmpPath("status-insecure");
    process.env.AI2NAO_GITHUB_CONFIG = path;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, '{"token":"ghp_bad_perm"}', "utf8");
    chmodSync(path, 0o644);
    const st = githubTokenStatus();
    if (process.platform !== "win32") {
      expect(st.insecureFilePermissions).toBe(true);
    }
    expect(st.configured).toBe(true);
    expect(st.source).toBe("file");
  });
});
