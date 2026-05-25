import { randomUUID } from "node:crypto";
import type {
  BashPermissionDebug,
  BashPermissionRule,
  BashPermissionRuleInput,
  BashPermissionRuleSuggestion,
  BashToolRisk,
} from "./types.js";
import type { BashPermissionRuleStore } from "./rules.js";

export type BashApprovalStatus = "pending" | "approved" | "denied" | "expired";

export type BashApprovalRequest = {
  id: string;
  sessionId: string | null;
  command: string;
  cwd: string;
  risk: BashToolRisk;
  description: string | null;
  status: BashApprovalStatus;
  source: "local" | "remote";
  remoteRequestId: string | null;
  orphaned: boolean;
  mode: BashPermissionDebug["mode"];
  suggestedRules: BashPermissionRuleSuggestion[];
  debug: BashPermissionDebug | null;
  savedRule: BashPermissionRule | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
};

export type BashApprovalDecision = "approved" | "denied" | "expired";

export type BashApprovalResolution = {
  status: BashApprovalDecision;
  savedRule: BashPermissionRule | null;
};

type PendingResolver = {
  resolve: (decision: BashApprovalResolution) => void;
  timeout: NodeJS.Timeout;
};

export type BashApprovalStore = {
  create(input: {
    sessionId?: string | null;
    command: string;
    cwd: string;
    risk: BashToolRisk;
    description?: string;
    source?: "local" | "remote";
    remoteRequestId?: string | null;
    mode?: BashPermissionDebug["mode"];
    suggestedRules?: BashPermissionRuleSuggestion[];
    debug?: BashPermissionDebug | null;
    ttlMs?: number;
  }): Promise<BashApprovalResolution>;
  createExternal(input: {
    sessionId?: string | null;
    command: string;
    cwd: string;
    risk: BashToolRisk;
    description?: string;
    remoteRequestId?: string | null;
    mode?: BashPermissionDebug["mode"];
    suggestedRules?: BashPermissionRuleSuggestion[];
    debug?: BashPermissionDebug | null;
    ttlMs?: number;
  }): BashApprovalRequest;
  get(id: string): BashApprovalRequest | null;
  listPending(sessionId?: string | null, options?: { includeOrphans?: boolean }): BashApprovalRequest[];
  decide(
    id: string,
    decision: Exclude<BashApprovalDecision, "expired">,
    options?: { rememberRule?: BashPermissionRuleInput }
  ): BashApprovalRequest | null;
  listRules(behavior?: BashPermissionRuleInput["behavior"]): BashPermissionRule[];
  addRule(input: BashPermissionRuleInput): BashPermissionRule;
  updateRule(id: string, input: BashPermissionRuleInput): BashPermissionRule | null;
  removeRule(id: string): boolean;
};

const DEFAULT_TTL_MS = 120_000;

export function createBashApprovalStore(options?: {
  ruleStore?: BashPermissionRuleStore;
}): BashApprovalStore {
  const requests = new Map<string, BashApprovalRequest>();
  const resolvers = new Map<string, PendingResolver>();
  const externalExpiryTimers = new Map<string, NodeJS.Timeout>();

  function finish(
    id: string,
    decision: BashApprovalDecision,
    finishOptions?: { rememberRule?: BashPermissionRuleInput }
  ): BashApprovalRequest | null {
    const request = requests.get(id);
    if (!request || request.status !== "pending") return null;
    const resolver = resolvers.get(id);
    const externalExpiry = externalExpiryTimers.get(id);
    const savedRule =
      decision === "approved" && finishOptions?.rememberRule && options?.ruleStore
        ? options.ruleStore.add(withDefaultDirectoryScope(finishOptions.rememberRule, request.cwd))
        : decision === "denied" && finishOptions?.rememberRule && options?.ruleStore
          ? options.ruleStore.add(
              withDefaultDirectoryScope(
                { ...finishOptions.rememberRule, behavior: "deny" },
                request.cwd
              )
            )
          : null;
    if (resolver) {
      clearTimeout(resolver.timeout);
      resolver.resolve({ status: decision, savedRule });
      resolvers.delete(id);
    }
    if (externalExpiry) {
      clearTimeout(externalExpiry);
      externalExpiryTimers.delete(id);
    }
    const updated: BashApprovalRequest = {
      ...request,
      status: decision,
      savedRule,
      decidedAt: new Date().toISOString(),
    };
    requests.set(id, updated);
    return updated;
  }

  function createRequest(input: {
    sessionId?: string | null;
    command: string;
    cwd: string;
    risk: BashToolRisk;
    description?: string;
    source?: "local" | "remote";
    remoteRequestId?: string | null;
    mode?: BashPermissionDebug["mode"];
    suggestedRules?: BashPermissionRuleSuggestion[];
    debug?: BashPermissionDebug | null;
    ttlMs?: number;
  }): { request: BashApprovalRequest; ttlMs: number } {
    const now = Date.now();
    const ttlMs = Math.max(5_000, Math.min(input.ttlMs ?? DEFAULT_TTL_MS, 10 * 60_000));
    const sessionId = input.sessionId?.trim() || null;
    const request: BashApprovalRequest = {
      id: randomUUID(),
      sessionId,
      command: input.command,
      cwd: input.cwd,
      risk: input.risk,
      description: input.description?.trim() || null,
      status: "pending",
      source: input.source ?? "local",
      remoteRequestId: input.remoteRequestId?.trim() || null,
      orphaned: !sessionId,
      mode: input.mode ?? "default",
      suggestedRules: input.suggestedRules ?? [],
      debug: input.debug ?? null,
      savedRule: null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      decidedAt: null,
    };
    requests.set(request.id, request);
    return { request, ttlMs };
  }

  function installExpiry(id: string, ttlMs: number): NodeJS.Timeout {
    const timeout = setTimeout(() => {
      finish(id, "expired");
    }, ttlMs);
    timeout.unref();
    return timeout;
  }

  return {
    create(input) {
      const { request, ttlMs } = createRequest(input);
      return new Promise<BashApprovalResolution>((resolve) => {
        resolvers.set(request.id, { resolve, timeout: installExpiry(request.id, ttlMs) });
      });
    },
    createExternal(input) {
      const { request, ttlMs } = createRequest({ ...input, source: "remote" });
      externalExpiryTimers.set(request.id, installExpiry(request.id, ttlMs));
      return request;
    },
    get(id) {
      return requests.get(id) ?? null;
    },
    listPending(sessionId, listOptions) {
      const normalizedSessionId = sessionId?.trim() || null;
      return [...requests.values()].filter((request) => {
        if (request.status !== "pending") return false;
        if (normalizedSessionId && request.sessionId === normalizedSessionId) return true;
        if (!normalizedSessionId && !request.sessionId) return true;
        return Boolean(listOptions?.includeOrphans && request.orphaned);
      });
    },
    decide(id, decision, decideOptions) {
      return finish(id, decision, decideOptions);
    },
    listRules(behavior) {
      return options?.ruleStore?.list(behavior) ?? [];
    },
    addRule(input) {
      if (!options?.ruleStore) throw new Error("permission rules are not configured");
      return options.ruleStore.add(input);
    },
    updateRule(id, input) {
      if (!options?.ruleStore) throw new Error("permission rules are not configured");
      return options.ruleStore.update(id, input);
    },
    removeRule(id) {
      return options?.ruleStore?.remove(id) ?? false;
    },
  };
}

export const defaultBashApprovalStore = createBashApprovalStore();

function withDefaultDirectoryScope(
  input: BashPermissionRuleInput,
  cwd: string
): BashPermissionRuleInput {
  return {
    ...input,
    scopeType: input.scopeType ?? "directory",
    scopeValue: input.scopeValue ?? cwd,
    source: "suggested",
  };
}
