import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultKimiCliRoot } from "../src/kimiHistory/paths.js";
import { kimiProjectPath, readKimiSessionMeta, scanKimiWireFiles } from "../src/kimiHistory/scan.js";

/**
 * `state.json` 的双格式回归。
 *
 * kimi 有两种会话状态格式,工作目录字段名不同(2026-08-20 实测 57 个会话):
 *   旧格式  `workDir`,无 version    34 个(CLI + 桌面)
 *   v2      `cwd`,   `version: 2`  23 个(仅 CLI)
 *
 * 只读 `workDir` 时那 23 个会话的项目归属全丢,按 token 加权 54.5%。
 * 这组用例守着「两种格式都能解析」,合成 fixture 跑在任何机器上。
 */

/** 造一个会话目录,返回它的 wire.jsonl 路径。`state` 为 null 表示不写 state.json。 */
function makeSession(root: string, sessionId: string, state: unknown | null): string {
  const sessionDir = join(root, "wd_fixture_0000", sessionId);
  const agentDir = join(sessionDir, "agents", "main");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "wire.jsonl"), "");
  if (state !== null) {
    writeFileSync(join(sessionDir, "state.json"), JSON.stringify(state));
  }
  return join(agentDir, "wire.jsonl");
}

describe("readKimiSessionMeta 的 state.json 双格式", () => {
  const root = mkdtempSync(join(tmpdir(), "ai2nao-kimi-meta-"));

  it("旧格式:读 workDir", () => {
    const wire = makeSession(root, "session_old", {
      workDir: "/p/old-format",
      title: "旧格式会话",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
    });
    expect(readKimiSessionMeta(wire)).toEqual({
      workDir: "/p/old-format",
      title: "旧格式会话",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
    });
  });

  it("v2 格式:读 cwd —— 修复前这里是 null,54.5% 的 token 因此丢了项目归属", () => {
    const wire = makeSession(root, "session_v2", {
      id: "session_v2",
      version: 2,
      cwd: "/p/v2-format",
      title: "v2 会话",
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-02T00:00:00Z",
      archived: false,
      agents: {},
      lastPrompt: "…",
      isCustomTitle: false,
    });
    expect(readKimiSessionMeta(wire).workDir).toBe("/p/v2-format");
  });

  it("两个字段都在时 workDir 优先(旧格式是既有行为,不能被 cwd 顶掉)", () => {
    const wire = makeSession(root, "session_both", {
      workDir: "/p/wins",
      cwd: "/p/loses",
    });
    expect(readKimiSessionMeta(wire).workDir).toBe("/p/wins");
  });

  it("workDir 是空串时退到 cwd(str() 把空串当没有)", () => {
    const wire = makeSession(root, "session_empty", { workDir: "   ", cwd: "/p/fallback" });
    expect(readKimiSessionMeta(wire).workDir).toBe("/p/fallback");
  });

  it("两个字段都没有 → null(不是崩溃)", () => {
    const wire = makeSession(root, "session_neither", { id: "x", version: 2, title: "无目录" });
    expect(readKimiSessionMeta(wire).workDir).toBeNull();
  });

  it("没有 state.json → 四个字段全 null", () => {
    const wire = makeSession(root, "session_nostate", null);
    expect(readKimiSessionMeta(wire)).toEqual({
      workDir: null,
      title: null,
      createdAt: null,
      updatedAt: null,
    });
  });

  it("state.json 是坏 JSON → 四个字段全 null,不抛", () => {
    const wire = makeSession(root, "session_badjson", null);
    writeFileSync(join(wire, "..", "..", "..", "state.json"), "{ not json");
    expect(() => readKimiSessionMeta(wire)).not.toThrow();
    expect(readKimiSessionMeta(wire).workDir).toBeNull();
  });
});

/**
 * 真实机器上的回归断言:修复之后,还剩下的 null 只允许来自桌面沙箱
 * (它们的 workDir 真的等于沙箱默认目录,不是真项目,应当保持 null)。
 */
describe.skipIf(!existsSync(defaultKimiCliRoot()))("真实数据:v2 会话不再丢项目归属", () => {
  it("CLI 侧没有任何会话的 workDir 为 null", () => {
    const nullOnes = scanKimiWireFiles()
      .files.filter((f) => f.rootKind === "cli")
      .filter((f) => readKimiSessionMeta(f.filePath).workDir === null)
      .map((f) => f.sessionId);
    expect(nullOnes).toEqual([]);
  });

  it("kimiProjectPath 返回 null 的文件全部来自桌面沙箱", () => {
    const nullProject = scanKimiWireFiles().files.filter(
      (f) => kimiProjectPath(readKimiSessionMeta(f.filePath)) === null
    );
    expect(nullProject.every((f) => f.rootKind === "desktop")).toBe(true);
  });
});
