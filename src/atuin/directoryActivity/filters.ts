import type {
  DirectoryActivityConfig,
  DirectoryActivityFilterRule,
} from "./types.js";

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

export function matchesDirectoryActivityRule(
  command: string,
  rule: DirectoryActivityFilterRule
): boolean {
  const normalized = normalizeCommand(command);
  const value = normalizeCommand(rule.value);
  if (rule.kind === "exact") return normalized === value;
  if (rule.kind === "prefix") return normalized === value || normalized.startsWith(`${value} `);
  return normalized.includes(value);
}

export function isLowInfoDirectoryCommand(
  command: string,
  config: DirectoryActivityConfig
): boolean {
  return config.lowInfoCommands.some((rule) =>
    matchesDirectoryActivityRule(command, rule)
  );
}

export function includeInFilteredDirectoryActivity(
  command: string,
  config: DirectoryActivityConfig
): boolean {
  if (config.includeLowInfoCommands) return true;
  return !isLowInfoDirectoryCommand(command, config);
}
