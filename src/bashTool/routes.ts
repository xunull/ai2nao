import type { Hono } from "hono";
import { defaultBashApprovalStore, type BashApprovalStore } from "./approvalStore.js";
import {
  getBashSandboxStatus,
  normalizeBashSandboxConfig,
  writeBashSandboxConfig,
} from "./sandboxConfig.js";
import { checkBashPermission } from "./permissions.js";
import type {
  BashPermissionRuleInput,
  BashPermissionRuleScopeType,
  BashPermissionRuleType,
} from "./types.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function registerBashApprovalRoutes(
  app: Hono,
  approvalStore: BashApprovalStore = defaultBashApprovalStore
): void {
  app.get("/api/bash-approvals", (c) => {
    const sessionId = c.req.query("sessionId")?.trim();
    const includeOrphans = c.req.query("includeOrphans") === "1";
    if (!sessionId && !includeOrphans) return jsonErr(400, "sessionId is required");
    return c.json({ approvals: approvalStore.listPending(sessionId, { includeOrphans }) });
  });

  app.get("/api/bash-approvals/:id", (c) => {
    const approval = approvalStore.get(c.req.param("id"));
    if (!approval) return jsonErr(404, "approval request not found");
    return c.json({ approval });
  });

  app.post("/api/bash-approvals/remote", async (c) => {
    const body = await safeJson(c.req.raw);
    const command = stringField(body.command).trim();
    if (!command) return jsonErr(400, "command is required");
    const permission = checkBashPermission(command);
    if (!permission.allow) return jsonErr(403, permission.reason);
    const approval = approvalStore.createExternal({
      sessionId: optionalString(body.sessionId),
      command: permission.normalizedCommand,
      cwd: optionalString(body.cwd) ?? ".",
      risk: permission.risk,
      description: optionalString(body.description),
      remoteRequestId: optionalString(body.remoteRequestId),
      ttlMs: numberField(body.ttlMs),
    });
    return c.json({ approval }, 201);
  });

  app.post("/api/bash-approvals/:id/approve", async (c) => {
    const body = await safeJson(c.req.raw);
    let rememberRule: BashPermissionRuleInput | undefined;
    try {
      rememberRule = rememberRuleFromBody(body, "allow");
    } catch (error) {
      return jsonErr(400, error instanceof Error ? error.message : String(error));
    }
    const approval = approvalStore.decide(c.req.param("id"), "approved", {
      rememberRule,
    });
    if (!approval) return jsonErr(404, "approval request not found or already decided");
    return c.json({ approval });
  });

  app.post("/api/bash-approvals/:id/deny", async (c) => {
    const body = await safeJson(c.req.raw);
    let rememberRule: BashPermissionRuleInput | undefined;
    try {
      rememberRule = rememberRuleFromBody(body, "deny");
    } catch (error) {
      return jsonErr(400, error instanceof Error ? error.message : String(error));
    }
    const approval = approvalStore.decide(c.req.param("id"), "denied", {
      rememberRule,
    });
    if (!approval) return jsonErr(404, "approval request not found or already decided");
    return c.json({ approval });
  });

  app.get("/api/bash-permission-rules", (c) => {
    const behavior = c.req.query("behavior");
    if (behavior && behavior !== "allow" && behavior !== "ask" && behavior !== "deny") {
      return jsonErr(400, "behavior must be allow, ask, or deny");
    }
    const parsedBehavior = behavior as BashPermissionRuleInput["behavior"] | undefined;
    return c.json({ rules: approvalStore.listRules(parsedBehavior) });
  });

  app.post("/api/bash-permission-rules", async (c) => {
    const body = await safeJson(c.req.raw);
    try {
      const rule = approvalStore.addRule(parseRuleInput(body));
      return c.json({ rule }, 201);
    } catch (error) {
      return jsonErr(400, error instanceof Error ? error.message : String(error));
    }
  });

  app.patch("/api/bash-permission-rules/:id", async (c) => {
    const body = await safeJson(c.req.raw);
    try {
      const rule = approvalStore.updateRule(c.req.param("id"), parseRuleInput(body));
      if (!rule) return jsonErr(404, "permission rule not found");
      return c.json({ rule });
    } catch (error) {
      return jsonErr(400, error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/bash-permission-rules/:id", (c) => {
    const ok = approvalStore.removeRule(c.req.param("id"));
    if (!ok) return jsonErr(404, "permission rule not found");
    return c.json({ ok: true });
  });

  app.get("/api/bash-sandbox/status", (c) => {
    return c.json(getBashSandboxStatus());
  });

  app.post("/api/bash-sandbox/config", async (c) => {
    const body = await safeJson(c.req.raw);
    try {
      const configInput = body.config && typeof body.config === "object" ? body.config : body;
      const config = normalizeBashSandboxConfig(configInput);
      writeBashSandboxConfig(config);
      return c.json(getBashSandboxStatus());
    } catch (error) {
      return jsonErr(400, error instanceof Error ? error.message : String(error));
    }
  });
}

async function safeJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rememberRuleFromBody(
  body: Record<string, unknown>,
  fallbackBehavior: BashPermissionRuleInput["behavior"]
): BashPermissionRuleInput | undefined {
  if (body.remember !== true && !body.rememberRule) return undefined;
  if (body.rememberRule && typeof body.rememberRule === "object") {
    return parseRuleInput(body.rememberRule as Record<string, unknown>, fallbackBehavior);
  }
  const ruleContent = stringField(body.ruleContent).trim();
  if (!ruleContent) return undefined;
  return parseRuleInput({ ...body, behavior: fallbackBehavior });
}

function parseRuleInput(
  body: Record<string, unknown>,
  fallbackBehavior?: BashPermissionRuleInput["behavior"]
): BashPermissionRuleInput {
  const behavior = stringField(body.behavior) || fallbackBehavior || "allow";
  if (behavior !== "allow" && behavior !== "ask" && behavior !== "deny") {
    throw new Error("behavior must be allow, ask, or deny");
  }
  const ruleContent = stringField(body.ruleContent).trim();
  if (!ruleContent) throw new Error("ruleContent is required");
  const rawRuleType = stringField(body.ruleType);
  const ruleType: BashPermissionRuleType | undefined =
    rawRuleType === "exact" || rawRuleType === "prefix" || rawRuleType === "wildcard"
      ? rawRuleType
      : undefined;
  const rawScopeType = stringField(body.scopeType);
  const scopeType: BashPermissionRuleScopeType | undefined =
    rawScopeType === "global" || rawScopeType === "directory" ? rawScopeType : undefined;
  return {
    behavior,
    ruleType,
    ruleContent,
    scopeType,
    scopeValue: optionalString(body.scopeValue) ?? optionalString(body.cwd) ?? null,
    source: "user",
    note: optionalString(body.note) ?? null,
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  const str = stringField(value).trim();
  return str || undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
