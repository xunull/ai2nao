import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type Database from "better-sqlite3";
import type {
  BashPermissionBehavior,
  BashPermissionRule,
  BashPermissionRuleInput,
  BashPermissionRuleMatch,
  BashPermissionRuleSource,
  BashPermissionRuleScopeType,
  BashPermissionRuleSuggestion,
  BashPermissionRuleType,
} from "./types.js";

const BASH_TOOL_NAME = "ai2nao_run_shell";

export type BashPermissionRuleStore = {
  list(behavior?: BashPermissionBehavior): BashPermissionRule[];
  add(input: BashPermissionRuleInput): BashPermissionRule;
  update(id: string, input: BashPermissionRuleInput): BashPermissionRule | null;
  remove(id: string): boolean;
  matches(command: string, cwd?: string): BashPermissionRuleMatch[];
  recordUse(id: string): void;
};

export function createMemoryBashPermissionRuleStore(
  seed: BashPermissionRule[] = []
): BashPermissionRuleStore {
  const rules = new Map<string, BashPermissionRule>();
  for (const rule of seed) rules.set(rule.id, rule);

  return {
    list(behavior) {
      return [...rules.values()]
        .filter((rule) => rule.enabled && (!behavior || rule.behavior === behavior))
        .sort(sortRule);
    },
    add(input) {
      const now = new Date().toISOString();
      const rule = normalizeRuleInput(input, now);
      rules.set(rule.id, rule);
      return rule;
    },
    update(id, input) {
      const existing = rules.get(id);
      if (!existing || !existing.enabled) return null;
      const now = new Date().toISOString();
      const updated: BashPermissionRule = {
        ...existing,
        ...normalizeRuleFields(input),
        updatedAt: now,
      };
      rules.set(id, updated);
      return updated;
    },
    remove(id) {
      const rule = rules.get(id);
      if (!rule || !rule.enabled) return false;
      rules.set(id, { ...rule, enabled: false, updatedAt: new Date().toISOString() });
      return true;
    },
    matches(command, cwd) {
      return [...rules.values()]
        .filter((rule) => rule.enabled && scopeMatches(rule, cwd))
        .map((rule) => matchRule(command, rule))
        .filter((match) => match.matched)
        .sort((a, b) => sortRule(a.rule, b.rule));
    },
    recordUse(id) {
      const rule = rules.get(id);
      if (!rule) return;
      rules.set(id, {
        ...rule,
        lastUsedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        useCount: rule.useCount + 1,
      });
    },
  };
}

export function createSqliteBashPermissionRuleStore(
  db: Database.Database
): BashPermissionRuleStore {
  return {
    list(behavior) {
      const rows = behavior
        ? db
            .prepare(
              `SELECT * FROM bash_permission_rules
               WHERE tool_name = ? AND enabled = 1 AND behavior = ?
               ORDER BY created_at ASC`
            )
            .all(BASH_TOOL_NAME, behavior)
        : db
            .prepare(
              `SELECT * FROM bash_permission_rules
               WHERE tool_name = ? AND enabled = 1
               ORDER BY created_at ASC`
            )
            .all(BASH_TOOL_NAME);
      return rows.map(rowToRule).sort(sortRule);
    },
    add(input) {
      const now = new Date().toISOString();
      const rule = normalizeRuleInput(input, now);
      db.prepare(
        `INSERT INTO bash_permission_rules (
          id, tool_name, scope_type, scope_value, behavior, rule_type, rule_content, source, note,
          enabled, created_at, updated_at, last_used_at, use_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, 0)
        ON CONFLICT(tool_name, scope_type, scope_value, behavior, rule_type, rule_content)
        DO UPDATE SET enabled = 1, source = excluded.source, note = excluded.note, updated_at = excluded.updated_at`
      ).run(
        rule.id,
        BASH_TOOL_NAME,
        rule.scopeType,
        rule.scopeValue,
        rule.behavior,
        rule.ruleType,
        rule.ruleContent,
        rule.source,
        rule.note,
        rule.createdAt,
        rule.updatedAt
      );
      const saved = db
        .prepare(
          `SELECT * FROM bash_permission_rules
           WHERE tool_name = ? AND scope_type = ? AND scope_value = ? AND behavior = ? AND rule_type = ? AND rule_content = ?`
        )
        .get(BASH_TOOL_NAME, rule.scopeType, rule.scopeValue, rule.behavior, rule.ruleType, rule.ruleContent);
      return rowToRule(saved);
    },
    update(id, input) {
      const now = new Date().toISOString();
      const fields = normalizeRuleFields(input);
      const duplicate = db
        .prepare(
          `SELECT id FROM bash_permission_rules
           WHERE tool_name = ? AND scope_type = ? AND scope_value = ? AND behavior = ? AND rule_type = ? AND rule_content = ? AND id <> ?`
        )
        .get(
          BASH_TOOL_NAME,
          fields.scopeType,
          fields.scopeValue,
          fields.behavior,
          fields.ruleType,
          fields.ruleContent,
          id
        );
      if (duplicate) throw new Error("permission rule already exists");

      const result = db
        .prepare(
          `UPDATE bash_permission_rules
           SET scope_type = ?, scope_value = ?, behavior = ?, rule_type = ?, rule_content = ?,
               source = ?, note = ?, updated_at = ?
           WHERE id = ? AND tool_name = ? AND enabled = 1`
        )
        .run(
          fields.scopeType,
          fields.scopeValue,
          fields.behavior,
          fields.ruleType,
          fields.ruleContent,
          fields.source,
          fields.note,
          now,
          id,
          BASH_TOOL_NAME
        );
      if (result.changes === 0) return null;
      const saved = db
        .prepare(
          `SELECT * FROM bash_permission_rules
           WHERE id = ? AND tool_name = ? AND enabled = 1`
        )
        .get(id, BASH_TOOL_NAME);
      return rowToRule(saved);
    },
    remove(id) {
      const result = db
        .prepare(
          `UPDATE bash_permission_rules
           SET enabled = 0, updated_at = ?
           WHERE id = ? AND tool_name = ? AND enabled = 1`
        )
        .run(new Date().toISOString(), id, BASH_TOOL_NAME);
      return result.changes > 0;
    },
    matches(command, cwd) {
      return this.list()
        .filter((rule) => scopeMatches(rule, cwd))
        .map((rule) => matchRule(command, rule))
        .filter((match) => match.matched)
        .sort((a, b) => sortRule(a.rule, b.rule));
    },
    recordUse(id) {
      db.prepare(
        `UPDATE bash_permission_rules
         SET last_used_at = ?, updated_at = ?, use_count = use_count + 1
         WHERE id = ? AND tool_name = ?`
      ).run(new Date().toISOString(), new Date().toISOString(), id, BASH_TOOL_NAME);
    },
  };
}

export function suggestBashPermissionRules(command: string): BashPermissionRuleSuggestion[] {
  const normalized = command.trim();
  if (!normalized) return [];

  const suggestions: BashPermissionRuleSuggestion[] = [];
  const prefix = stableCommandPrefix(normalized);
  if (prefix) {
    suggestions.push({
      behavior: "allow",
      ruleType: "prefix",
      ruleContent: `${prefix}:*`,
      label: `允许类似命令：${prefix}:*`,
    });
  }
  suggestions.push({
    behavior: "allow",
    ruleType: "exact",
    ruleContent: normalized,
    label: `只允许本条命令：${normalized}`,
  });
  return dedupeSuggestions(suggestions);
}

export function inferRuleType(ruleContent: string): BashPermissionRuleType {
  const trimmed = ruleContent.trim();
  if (trimmed.endsWith(":*")) return "prefix";
  if (hasUnescapedWildcard(trimmed)) return "wildcard";
  return "exact";
}

function normalizeRuleInput(input: BashPermissionRuleInput, now: string): BashPermissionRule {
  return {
    id: randomUUID(),
    ...normalizeRuleFields(input),
    enabled: true,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    useCount: 0,
  };
}

function normalizeRuleFields(input: BashPermissionRuleInput): Pick<
  BashPermissionRule,
  "behavior" | "ruleType" | "ruleContent" | "scopeType" | "scopeValue" | "source" | "note"
> {
  const ruleContent = input.ruleContent.trim();
  if (!ruleContent) throw new Error("ruleContent is required");
  return {
    behavior: input.behavior,
    ruleType: input.ruleType ?? inferRuleType(ruleContent),
    ruleContent,
    ...normalizeScope(input),
    source: input.source ?? "user",
    note: input.note?.trim() || null,
  };
}

function rowToRule(row: unknown): BashPermissionRule {
  const rec = row as Record<string, unknown>;
  return {
    id: String(rec.id),
    behavior: normalizeBehavior(String(rec.behavior)),
    ruleType: normalizeRuleType(String(rec.rule_type)),
    ruleContent: String(rec.rule_content),
    scopeType: normalizeScopeType(String(rec.scope_type ?? "global")),
    scopeValue: typeof rec.scope_value === "string" ? rec.scope_value : "",
    source: normalizeSource(String(rec.source)),
    note: typeof rec.note === "string" ? rec.note : null,
    enabled: rec.enabled === 1 || rec.enabled === true,
    createdAt: String(rec.created_at),
    updatedAt: String(rec.updated_at),
    lastUsedAt: typeof rec.last_used_at === "string" ? rec.last_used_at : null,
    useCount: Number(rec.use_count ?? 0),
  };
}

function normalizeScope(input: BashPermissionRuleInput): {
  scopeType: BashPermissionRuleScopeType;
  scopeValue: string;
} {
  const rawScopeValue = input.scopeValue?.trim() ?? "";
  const scopeType = input.scopeType ?? (rawScopeValue ? "directory" : "global");
  if (scopeType === "global") return { scopeType, scopeValue: "" };
  if (!rawScopeValue) throw new Error("scopeValue is required for directory-scoped rules");
  return { scopeType, scopeValue: resolve(rawScopeValue) };
}

function scopeMatches(rule: BashPermissionRule, cwd: string | undefined): boolean {
  if (rule.scopeType === "global") return true;
  if (!cwd || !rule.scopeValue) return false;
  const scope = resolve(rule.scopeValue);
  const current = resolve(cwd);
  const rel = relative(scope, current);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function matchRule(command: string, rule: BashPermissionRule): BashPermissionRuleMatch {
  const normalized = command.trim();
  if (rule.ruleType === "exact") {
    const matched = normalized === rule.ruleContent;
    return { rule, matched, reason: matched ? "exact command match" : "exact command mismatch" };
  }
  if (rule.ruleType === "prefix") {
    const prefix = rule.ruleContent.endsWith(":*")
      ? rule.ruleContent.slice(0, -2).trim()
      : rule.ruleContent.trim();
    const matched = normalized === prefix || normalized.startsWith(`${prefix} `);
    return { rule, matched, reason: matched ? `prefix match: ${prefix}` : `prefix mismatch: ${prefix}` };
  }
  const matched = matchWildcard(rule.ruleContent, normalized);
  return { rule, matched, reason: matched ? `wildcard match: ${rule.ruleContent}` : "wildcard mismatch" };
}

function matchWildcard(pattern: string, command: string): boolean {
  let regex = "";
  let escaped = false;
  for (const ch of pattern.trim()) {
    if (escaped) {
      regex += escapeRegex(ch);
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    regex += ch === "*" ? ".*" : escapeRegex(ch);
  }
  if (escaped) regex += "\\\\";
  return new RegExp(`^${regex}$`, "s").test(command);
}

function hasUnescapedWildcard(value: string): boolean {
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "*") return true;
  }
  return false;
}

function stableCommandPrefix(command: string): string | null {
  const tokens = command.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  const [cmd, sub] = tokens;
  if (!cmd || !sub) return null;
  if (!/^[a-z][a-z0-9-]*$/.test(cmd)) return null;
  if (!/^[a-z][a-z0-9-]*$/.test(sub)) return null;
  if (["bash", "sh", "zsh", "fish", "sudo", "su", "env", "xargs"].includes(cmd)) return null;
  return `${cmd} ${sub}`;
}

function dedupeSuggestions(
  suggestions: BashPermissionRuleSuggestion[]
): BashPermissionRuleSuggestion[] {
  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    const key = `${suggestion.ruleType}:${suggestion.ruleContent}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortRule(a: BashPermissionRule, b: BashPermissionRule): number {
  const behaviorRank: Record<BashPermissionBehavior, number> = { deny: 0, ask: 1, allow: 2 };
  const typeRank: Record<BashPermissionRuleType, number> = { exact: 0, prefix: 1, wildcard: 2 };
  const scopeRank: Record<BashPermissionRuleScopeType, number> = { directory: 0, global: 1 };
  return (
    behaviorRank[a.behavior] - behaviorRank[b.behavior] ||
    scopeRank[a.scopeType] - scopeRank[b.scopeType] ||
    typeRank[a.ruleType] - typeRank[b.ruleType] ||
    b.scopeValue.length - a.scopeValue.length ||
    a.createdAt.localeCompare(b.createdAt)
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBehavior(value: string): BashPermissionBehavior {
  if (value === "allow" || value === "ask" || value === "deny") return value;
  return "ask";
}

function normalizeRuleType(value: string): BashPermissionRuleType {
  if (value === "exact" || value === "prefix" || value === "wildcard") return value;
  return "exact";
}

function normalizeScopeType(value: string): BashPermissionRuleScopeType {
  if (value === "global" || value === "directory") return value;
  return "global";
}

function normalizeSource(value: string): BashPermissionRuleSource {
  if (value === "user" || value === "suggested" || value === "remote" || value === "system") {
    return value;
  }
  return "user";
}
