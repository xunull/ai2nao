import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { defaultAi2naoConfigPath } from "../../config.js";
import type {
  DirectoryActivityConfig,
  DirectoryActivityConfigIssue,
  DirectoryActivityConfigResult,
  DirectoryActivityFilterRule,
} from "./types.js";

export const DEFAULT_DIRECTORY_ACTIVITY_CONFIG: DirectoryActivityConfig = {
  includeLowInfoCommands: false,
  lowInfoCommands: [
    { kind: "exact", value: "pwd" },
    { kind: "exact", value: "ls" },
    { kind: "exact", value: "ll" },
    { kind: "exact", value: "la" },
    { kind: "exact", value: "clear" },
    { kind: "exact", value: "history" },
    { kind: "exact", value: "git status" },
    { kind: "exact", value: "git diff" },
    { kind: "prefix", value: "atuin search" },
  ],
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashDirectoryActivityConfig(config: DirectoryActivityConfig): string {
  return createHash("sha256").update(stableStringify(config)).digest("hex");
}

function issue(path: string, message: string): DirectoryActivityConfigIssue {
  return { path, message };
}

function parseRule(
  value: unknown,
  path: string,
  issues: DirectoryActivityConfigIssue[]
): DirectoryActivityFilterRule | null {
  if (!isObject(value)) {
    issues.push(issue(path, "rule must be an object"));
    return null;
  }
  const kind = value.kind;
  const raw = value.value;
  if (kind !== "literal" && kind !== "prefix" && kind !== "exact") {
    issues.push(issue(`${path}.kind`, "rule kind must be literal, prefix, or exact"));
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    issues.push(issue(`${path}.value`, "rule value must be a non-empty string"));
  }
  if (
    (kind === "literal" || kind === "prefix" || kind === "exact") &&
    typeof raw === "string" &&
    raw.trim().length > 0
  ) {
    return { kind, value: raw.trim() };
  }
  return null;
}

function parseDirectoryActivityConfig(
  root: unknown
): { config: DirectoryActivityConfig | null; issues: DirectoryActivityConfigIssue[] } {
  const issues: DirectoryActivityConfigIssue[] = [];
  if (!isObject(root)) {
    return { config: null, issues: [issue("$", "config root must be an object")] };
  }
  const atuin = root.atuin;
  if (atuin == null) {
    return { config: DEFAULT_DIRECTORY_ACTIVITY_CONFIG, issues };
  }
  if (!isObject(atuin)) {
    return { config: null, issues: [issue("$.atuin", "atuin must be an object")] };
  }
  const section = atuin.directoryActivity;
  if (section == null) {
    return { config: DEFAULT_DIRECTORY_ACTIVITY_CONFIG, issues };
  }
  if (!isObject(section)) {
    return {
      config: null,
      issues: [issue("$.atuin.directoryActivity", "directoryActivity must be an object")],
    };
  }

  const allowed = new Set(["includeLowInfoCommands", "lowInfoCommands"]);
  for (const key of Object.keys(section)) {
    if (!allowed.has(key)) {
      issues.push(issue(`$.atuin.directoryActivity.${key}`, "unknown config key"));
    }
  }

  const includeLowInfoCommands =
    section.includeLowInfoCommands == null
      ? DEFAULT_DIRECTORY_ACTIVITY_CONFIG.includeLowInfoCommands
      : section.includeLowInfoCommands;
  if (typeof includeLowInfoCommands !== "boolean") {
    issues.push(
      issue(
        "$.atuin.directoryActivity.includeLowInfoCommands",
        "includeLowInfoCommands must be a boolean"
      )
    );
  }

  let lowInfoCommands = DEFAULT_DIRECTORY_ACTIVITY_CONFIG.lowInfoCommands;
  if (section.lowInfoCommands != null) {
    if (!Array.isArray(section.lowInfoCommands)) {
      issues.push(
        issue("$.atuin.directoryActivity.lowInfoCommands", "lowInfoCommands must be an array")
      );
    } else {
      const parsed: DirectoryActivityFilterRule[] = [];
      section.lowInfoCommands.forEach((item, index) => {
        const rule = parseRule(
          item,
          `$.atuin.directoryActivity.lowInfoCommands[${index}]`,
          issues
        );
        if (rule) parsed.push(rule);
      });
      lowInfoCommands = parsed;
    }
  }

  if (issues.length > 0) return { config: null, issues };
  return {
    config: {
      includeLowInfoCommands: includeLowInfoCommands as boolean,
      lowInfoCommands,
    },
    issues,
  };
}

export function readDirectoryActivityConfig(
  configPath = defaultAi2naoConfigPath()
): DirectoryActivityConfigResult {
  if (!existsSync(configPath)) {
    const config = DEFAULT_DIRECTORY_ACTIVITY_CONFIG;
    return {
      ok: true,
      path: configPath,
      exists: false,
      config,
      hash: hashDirectoryActivityConfig(config),
    };
  }
  let root: unknown;
  try {
    root = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    return {
      ok: false,
      path: configPath,
      issues: [issue("$", e instanceof Error ? e.message : String(e))],
    };
  }
  const parsed = parseDirectoryActivityConfig(root);
  if (!parsed.config) return { ok: false, path: configPath, issues: parsed.issues };
  return {
    ok: true,
    path: configPath,
    exists: true,
    config: parsed.config,
    hash: hashDirectoryActivityConfig(parsed.config),
  };
}
