import type { BashSandboxDebug } from "./sandboxRunner.js";

export type BashToolRisk = "read-only" | "project-command";

export type BashPermissionBehavior = "allow" | "ask" | "deny";

export type BashPermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";

export type BashPermissionRuleType = "exact" | "prefix" | "wildcard";

export type BashPermissionRuleSource = "user" | "suggested" | "remote" | "system";

export type BashPermissionRuleScopeType = "global" | "directory";

export type BashPermissionRuleInput = {
  behavior: BashPermissionBehavior;
  ruleContent: string;
  ruleType?: BashPermissionRuleType;
  scopeType?: BashPermissionRuleScopeType;
  scopeValue?: string | null;
  source?: BashPermissionRuleSource;
  note?: string | null;
};

export type BashPermissionRule = {
  id: string;
  behavior: BashPermissionBehavior;
  ruleType: BashPermissionRuleType;
  ruleContent: string;
  scopeType: BashPermissionRuleScopeType;
  scopeValue: string;
  source: BashPermissionRuleSource;
  note: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  useCount: number;
};

export type BashPermissionRuleMatch = {
  rule: BashPermissionRule;
  matched: boolean;
  reason: string;
};

export type BashPermissionRuleSuggestion = {
  behavior: "allow";
  ruleType: BashPermissionRuleType;
  ruleContent: string;
  label: string;
};

export type BashPermissionDecisionReason =
  | { type: "static"; message: string }
  | { type: "rule"; behavior: BashPermissionBehavior; ruleId: string; ruleContent: string }
  | { type: "mode"; mode: BashPermissionMode; message: string }
  | { type: "default"; message: string };

export type BashPermissionDebug = {
  mode: BashPermissionMode;
  baseRisk?: BashToolRisk;
  decision: BashPermissionBehavior;
  decisionReason: BashPermissionDecisionReason;
  matchedRules: BashPermissionRuleMatch[];
  suggestedRules: BashPermissionRuleSuggestion[];
  source: "local" | "remote";
  orphaned: boolean;
};

export type BashToolRequest = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  description?: string;
};

export type BashToolResult = {
  ok: boolean;
  command: string;
  cwd: string;
  risk: BashToolRisk;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  approval?: BashToolApproval;
  deniedReason?: string;
  permissionDebug?: BashPermissionDebug;
  sandboxDebug?: BashSandboxDebug;
};

export type BashToolLimits = {
  timeoutMs: number;
  maxTimeoutMs: number;
  maxCommandChars: number;
  maxOutputChars: number;
};

export type BashToolApproval = {
  required: boolean;
  status: "not_required" | "approved" | "denied" | "expired";
  reason: string;
  savedRule?: BashPermissionRule | null;
};

export type BashPermissionDecision =
  | {
      allow: true;
      risk: BashToolRisk;
      normalizedCommand: string;
      subcommands: string[];
    }
  | {
      allow: false;
      reason: string;
    };
