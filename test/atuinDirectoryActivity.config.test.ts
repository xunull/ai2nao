import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { readDirectoryActivityConfig } from "../src/atuin/directoryActivity/config.js";

function tempPath(name: string): string {
  const base = join(tmpdir(), `ai2nao-dir-config-${Date.now()}-${Math.random()}`);
  mkdirSync(base, { recursive: true });
  return join(base, name);
}

describe("Atuin directory activity config", () => {
  it("uses defaults when global config is missing", () => {
    const result = readDirectoryActivityConfig(tempPath("missing.json"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exists).toBe(false);
    expect(result.config.includeLowInfoCommands).toBe(false);
    expect(result.config.lowInfoCommands.some((rule) => rule.value === "git status")).toBe(true);
    expect(result.hash).toHaveLength(64);
  });

  it("strictly validates the directoryActivity section", () => {
    const path = tempPath("config.json");
    writeFileSync(
      path,
      JSON.stringify({
        atuin: {
          directoryActivity: {
            includeLowInfoCommands: "yes",
            lowInfoCommands: [{ kind: "regex", value: ".*" }],
          },
        },
      }),
      "utf8"
    );
    const result = readDirectoryActivityConfig(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "$.atuin.directoryActivity.includeLowInfoCommands",
      "$.atuin.directoryActivity.lowInfoCommands[0].kind",
    ]);
  });

  it("accepts literal, prefix, and exact rules", () => {
    const path = tempPath("config.json");
    writeFileSync(
      path,
      JSON.stringify({
        atuin: {
          directoryActivity: {
            includeLowInfoCommands: true,
            lowInfoCommands: [
              { kind: "exact", value: "pwd" },
              { kind: "prefix", value: "git" },
              { kind: "literal", value: "--help" },
            ],
          },
        },
      }),
      "utf8"
    );
    const result = readDirectoryActivityConfig(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.lowInfoCommands).toHaveLength(3);
  });
});
