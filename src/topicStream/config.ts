import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { defaultAi2naoConfigPath } from "../config.js";
import {
  DEFAULT_TAXONOMY,
  OTHER_CATEGORY,
  TAXONOMY_RULE_KINDS,
  type TaxonomyRule,
  type TopicCategory,
} from "./classify.js";

/** Default session-gap threshold (minutes) for Stage 2 sessionization. */
export const DEFAULT_GAP_MINUTES = 30;

/** Rule version = stable hash of the classification-relevant config (taxonomy + gap). */
function configHash(categories: TopicCategory[], gapMinutes: number): string {
  const canonical = JSON.stringify({
    categories: categories.map((c) => ({ name: c.name, rules: c.rules })),
    gapMinutes,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/**
 * Optional per-user taxonomy override in `~/.ai2nao/config.json`:
 *
 *   { "topicStream": { "categories": [
 *       { "name": "自建/Homelab", "color": "#5ec8a0", "rules": [
 *         { "kind": "domainSuffix", "value": "example-homelab.tld" },
 *         { "kind": "hostPrefix",   "value": "192.168." }
 *       ] }
 *   ] } }
 *
 * This is where personal/private domains and LAN IPs live — they never belong
 * in the shipped default taxonomy of a public repo. Strict mode (mirrors the
 * Atuin directory-activity config): unknown keys / bad types / invalid rules
 * make the read fail, and the rebuild preserves old rows + records the error.
 */

export type TopicStreamConfigIssue = { path: string; message: string };

export type TopicStreamConfigResult =
  | {
      ok: true;
      path: string;
      exists: boolean;
      categories: TopicCategory[];
      gapMinutes: number;
      hash: string;
    }
  | { ok: false; path: string; issues: TopicStreamConfigIssue[] };

const FALLBACK_PALETTE = [
  "#4f9dff",
  "#3fb98f",
  "#a06bff",
  "#e0a33a",
  "#ff8a5c",
  "#c98bdb",
  "#6c9fb8",
  "#e5688a",
  "#5ec8a0",
  "#d98a5a",
];

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(path: string, message: string): TopicStreamConfigIssue {
  return { path, message };
}

function parseRule(
  value: unknown,
  path: string,
  issues: TopicStreamConfigIssue[]
): TaxonomyRule | null {
  if (!isObject(value)) {
    issues.push(issue(path, "rule must be an object"));
    return null;
  }
  const allowed = new Set(["kind", "value"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(issue(`${path}.${key}`, "unknown rule key"));
  }
  const kind = value.kind;
  const raw = value.value;
  const kindOk = typeof kind === "string" && (TAXONOMY_RULE_KINDS as readonly string[]).includes(kind);
  if (!kindOk) {
    issues.push(issue(`${path}.kind`, `rule kind must be one of ${TAXONOMY_RULE_KINDS.join(", ")}`));
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    issues.push(issue(`${path}.value`, "rule value must be a non-empty string"));
  }
  if (kindOk && typeof raw === "string" && raw.trim().length > 0) {
    return { kind: kind as TaxonomyRule["kind"], value: raw.trim() };
  }
  return null;
}

function parseCategory(
  value: unknown,
  path: string,
  index: number,
  issues: TopicStreamConfigIssue[]
): TopicCategory | null {
  if (!isObject(value)) {
    issues.push(issue(path, "category must be an object"));
    return null;
  }
  const allowed = new Set(["name", "color", "rules"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(issue(`${path}.${key}`, "unknown category key"));
  }
  const name = value.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    issues.push(issue(`${path}.name`, "category name must be a non-empty string"));
  } else if (name.trim() === OTHER_CATEGORY) {
    issues.push(issue(`${path}.name`, `"${OTHER_CATEGORY}" is reserved for the fallback`));
  }
  const color = value.color;
  if (color != null && typeof color !== "string") {
    issues.push(issue(`${path}.color`, "color must be a string"));
  }
  let rules: TaxonomyRule[] = [];
  if (!Array.isArray(value.rules)) {
    issues.push(issue(`${path}.rules`, "rules must be an array"));
  } else {
    const parsed: TaxonomyRule[] = [];
    value.rules.forEach((item, i) => {
      const rule = parseRule(item, `${path}.rules[${i}]`, issues);
      if (rule) parsed.push(rule);
    });
    rules = parsed;
  }
  if (typeof name === "string" && name.trim().length > 0 && name.trim() !== OTHER_CATEGORY) {
    return {
      name: name.trim(),
      color: typeof color === "string" ? color : FALLBACK_PALETTE[index % FALLBACK_PALETTE.length],
      rules,
    };
  }
  return null;
}

function parse(root: unknown): {
  categories: TopicCategory[] | null;
  gapMinutes: number;
  issues: TopicStreamConfigIssue[];
} {
  const issues: TopicStreamConfigIssue[] = [];
  if (!isObject(root)) {
    return {
      categories: null,
      gapMinutes: DEFAULT_GAP_MINUTES,
      issues: [issue("$", "config root must be an object")],
    };
  }
  const section = root.topicStream;
  if (section == null) return { categories: DEFAULT_TAXONOMY, gapMinutes: DEFAULT_GAP_MINUTES, issues };
  if (!isObject(section)) {
    return {
      categories: null,
      gapMinutes: DEFAULT_GAP_MINUTES,
      issues: [issue("$.topicStream", "topicStream must be an object")],
    };
  }
  const allowed = new Set(["categories", "sessionGapMinutes"]);
  for (const key of Object.keys(section)) {
    if (!allowed.has(key)) issues.push(issue(`$.topicStream.${key}`, "unknown config key"));
  }
  let gapMinutes = DEFAULT_GAP_MINUTES;
  if (section.sessionGapMinutes != null) {
    const g = section.sessionGapMinutes;
    if (typeof g !== "number" || !Number.isFinite(g) || g <= 0) {
      issues.push(issue("$.topicStream.sessionGapMinutes", "sessionGapMinutes must be a positive number"));
    } else {
      gapMinutes = g;
    }
  }
  if (section.categories == null) {
    if (issues.length > 0) return { categories: null, gapMinutes, issues };
    return { categories: DEFAULT_TAXONOMY, gapMinutes, issues };
  }
  if (!Array.isArray(section.categories)) {
    issues.push(issue("$.topicStream.categories", "categories must be an array"));
    return { categories: null, gapMinutes, issues };
  }
  const parsed: TopicCategory[] = [];
  section.categories.forEach((item, i) => {
    const cat = parseCategory(item, `$.topicStream.categories[${i}]`, i, issues);
    if (cat) parsed.push(cat);
  });
  if (issues.length > 0) return { categories: null, gapMinutes, issues };
  // Merge: user categories come FIRST (their rules win ties), then the built-in
  // dev defaults whose names the user did not reuse. So you only write your
  // additions (homelab, forums, shopping…) and still get github/huggingface/etc.
  // Reuse a default category's exact name to override its rules.
  const userNames = new Set(parsed.map((c) => c.name));
  const effective = [...parsed, ...DEFAULT_TAXONOMY.filter((d) => !userNames.has(d.name))];
  return { categories: effective, gapMinutes, issues };
}

export function readTopicStreamConfig(
  configPath = defaultAi2naoConfigPath()
): TopicStreamConfigResult {
  if (!existsSync(configPath)) {
    return {
      ok: true,
      path: configPath,
      exists: false,
      categories: DEFAULT_TAXONOMY,
      gapMinutes: DEFAULT_GAP_MINUTES,
      hash: configHash(DEFAULT_TAXONOMY, DEFAULT_GAP_MINUTES),
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
  const parsed = parse(root);
  if (!parsed.categories) return { ok: false, path: configPath, issues: parsed.issues };
  return {
    ok: true,
    path: configPath,
    exists: true,
    categories: parsed.categories,
    gapMinutes: parsed.gapMinutes,
    hash: configHash(parsed.categories, parsed.gapMinutes),
  };
}
