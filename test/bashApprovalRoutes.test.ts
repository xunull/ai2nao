import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createBashApprovalStore, createMemoryBashPermissionRuleStore } from "../src/bashTool/index.js";
import { registerBashApprovalRoutes } from "../src/bashTool/routes.js";

describe("Bash approval routes", () => {
  it("lists and resolves pending shell approvals", async () => {
    const ruleStore = createMemoryBashPermissionRuleStore();
    const store = createBashApprovalStore({ ruleStore });
    const app = new Hono();
    registerBashApprovalRoutes(app, store);

    const pending = store.create({
      sessionId: "thread-1",
      command: "npm run test",
      cwd: "/repo",
      risk: "project-command",
      description: "verify",
      ttlMs: 30_000,
    });

    const list = await app.request("/api/bash-approvals?sessionId=thread-1");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { approvals: Array<{ id: string; command: string }> };
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]?.command).toBe("npm run test");

    const deny = await app.request(`/api/bash-approvals/${body.approvals[0]!.id}/deny`, {
      method: "POST",
    });
    expect(deny.status).toBe(200);
    await expect(pending).resolves.toMatchObject({ status: "denied" });

    const after = await app.request("/api/bash-approvals?sessionId=thread-1");
    const afterBody = (await after.json()) as { approvals: unknown[] };
    expect(afterBody.approvals).toEqual([]);
  });

  it("rejects malformed approval and rule requests before mutating state", async () => {
    const ruleStore = createMemoryBashPermissionRuleStore();
    const store = createBashApprovalStore({ ruleStore });
    const app = new Hono();
    registerBashApprovalRoutes(app, store);

    const noSession = await app.request("/api/bash-approvals");
    expect(noSession.status).toBe(400);

    const missingApproval = await app.request("/api/bash-approvals/missing");
    expect(missingApproval.status).toBe(404);

    const invalidBehavior = await app.request("/api/bash-permission-rules?behavior=maybe");
    expect(invalidBehavior.status).toBe(400);

    const missingRuleContent = await app.request("/api/bash-permission-rules", {
      method: "POST",
      body: JSON.stringify({ behavior: "allow" }),
      headers: { "content-type": "application/json" },
    });
    expect(missingRuleContent.status).toBe(400);

    const unsafeRemote = await app.request("/api/bash-approvals/remote", {
      method: "POST",
      body: JSON.stringify({ command: "rm -rf ." }),
      headers: { "content-type": "application/json" },
    });
    expect(unsafeRemote.status).toBe(403);

    expect(store.listRules()).toEqual([]);
  });

  it("persists an allow rule when approval remembers a suggestion", async () => {
    const ruleStore = createMemoryBashPermissionRuleStore();
    const store = createBashApprovalStore({ ruleStore });
    const app = new Hono();
    registerBashApprovalRoutes(app, store);

    const pending = store.create({
      sessionId: "thread-1",
      command: "npm run test",
      cwd: "/repo",
      risk: "project-command",
      description: "verify",
      suggestedRules: [
        {
          behavior: "allow",
          ruleType: "prefix",
          ruleContent: "npm run:*",
          label: "allow npm scripts",
        },
      ],
      ttlMs: 30_000,
    });
    const [approval] = store.listPending("thread-1");
    const approve = await app.request(`/api/bash-approvals/${approval!.id}/approve`, {
      method: "POST",
      body: JSON.stringify({
        remember: true,
        rememberRule: { behavior: "allow", ruleType: "prefix", ruleContent: "npm run:*" },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(approve.status).toBe(200);
    await expect(pending).resolves.toMatchObject({
      status: "approved",
      savedRule: {
        behavior: "allow",
        ruleContent: "npm run:*",
        scopeType: "directory",
        scopeValue: "/repo",
      },
    });
    const rules = await app.request("/api/bash-permission-rules");
    const body = (await rules.json()) as {
      rules: Array<{ behavior: string; ruleContent: string; scopeType: string; scopeValue: string }>;
    };
    expect(body.rules).toEqual([
      expect.objectContaining({
        behavior: "allow",
        ruleContent: "npm run:*",
        scopeType: "directory",
        scopeValue: "/repo",
      }),
    ]);
  });

  it("persists a deny rule when a denied approval remembers a command", async () => {
    const ruleStore = createMemoryBashPermissionRuleStore();
    const store = createBashApprovalStore({ ruleStore });
    const app = new Hono();
    registerBashApprovalRoutes(app, store);

    const pending = store.create({
      sessionId: "thread-1",
      command: "npm run deploy",
      cwd: "/repo",
      risk: "project-command",
      ttlMs: 30_000,
    });
    const [approval] = store.listPending("thread-1");
    const deny = await app.request(`/api/bash-approvals/${approval!.id}/deny`, {
      method: "POST",
      body: JSON.stringify({
        remember: true,
        ruleContent: "npm run deploy",
        ruleType: "exact",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(deny.status).toBe(200);
    await expect(pending).resolves.toMatchObject({
      status: "denied",
      savedRule: {
        behavior: "deny",
        ruleContent: "npm run deploy",
        scopeType: "directory",
        scopeValue: "/repo",
      },
    });
    expect(store.listRules("deny")).toEqual([
      expect.objectContaining({
        behavior: "deny",
        ruleContent: "npm run deploy",
        scopeValue: "/repo",
      }),
    ]);
  });

  it("lists rules by behavior and revokes saved rules", async () => {
    const ruleStore = createMemoryBashPermissionRuleStore();
    const store = createBashApprovalStore({ ruleStore });
    const app = new Hono();
    registerBashApprovalRoutes(app, store);

    const allow = store.addRule({
      behavior: "allow",
      ruleType: "prefix",
      ruleContent: "npm run:*",
      scopeType: "directory",
      scopeValue: "/repo-a",
    });
    store.addRule({
      behavior: "deny",
      ruleType: "exact",
      ruleContent: "npm run deploy",
      scopeType: "directory",
      scopeValue: "/repo-b",
    });

    const listAllow = await app.request("/api/bash-permission-rules?behavior=allow");
    expect(listAllow.status).toBe(200);
    const allowBody = (await listAllow.json()) as {
      rules: Array<{ id: string; behavior: string; ruleContent: string; scopeValue: string }>;
    };
    expect(allowBody.rules).toEqual([
      expect.objectContaining({
        id: allow.id,
        behavior: "allow",
        ruleContent: "npm run:*",
        scopeValue: "/repo-a",
      }),
    ]);

    const deleted = await app.request(`/api/bash-permission-rules/${allow.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);

    const listAfter = await app.request("/api/bash-permission-rules?behavior=allow");
    const afterBody = (await listAfter.json()) as { rules: unknown[] };
    expect(afterBody.rules).toEqual([]);

    const deleteAgain = await app.request(`/api/bash-permission-rules/${allow.id}`, {
      method: "DELETE",
    });
    expect(deleteAgain.status).toBe(404);
  });

  it("updates saved rules without dropping usage history", async () => {
    const ruleStore = createMemoryBashPermissionRuleStore();
    const store = createBashApprovalStore({ ruleStore });
    const app = new Hono();
    registerBashApprovalRoutes(app, store);

    const rule = store.addRule({
      behavior: "allow",
      ruleType: "prefix",
      ruleContent: "npm run:*",
      scopeType: "directory",
      scopeValue: "/repo-a",
      note: "old note",
    });
    ruleStore.recordUse(rule.id);

    const updated = await app.request(`/api/bash-permission-rules/${rule.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        behavior: "deny",
        ruleType: "exact",
        ruleContent: "npm run deploy",
        scopeType: "global",
        note: "block deploys",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      rule: {
        id: string;
        behavior: string;
        ruleType: string;
        ruleContent: string;
        scopeType: string;
        scopeValue: string;
        note: string | null;
        createdAt: string;
        lastUsedAt: string | null;
        useCount: number;
      };
    };
    expect(updatedBody.rule).toMatchObject({
      id: rule.id,
      behavior: "deny",
      ruleType: "exact",
      ruleContent: "npm run deploy",
      scopeType: "global",
      scopeValue: "",
      note: "block deploys",
      createdAt: rule.createdAt,
      useCount: 1,
    });
    expect(updatedBody.rule.lastUsedAt).not.toBeNull();

    const missing = await app.request("/api/bash-permission-rules/missing", {
      method: "PATCH",
      body: JSON.stringify({
        behavior: "allow",
        ruleContent: "pwd",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(missing.status).toBe(404);

    const invalid = await app.request(`/api/bash-permission-rules/${rule.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        behavior: "ask",
        ruleType: "exact",
        ruleContent: "pwd",
        scopeType: "directory",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(invalid.status).toBe(400);
  });

  it("creates remote orphan approval requests that can be resolved by id", async () => {
    const store = createBashApprovalStore();
    const app = new Hono();
    registerBashApprovalRoutes(app, store);

    const created = await app.request("/api/bash-approvals/remote", {
      method: "POST",
      body: JSON.stringify({
        command: "npm run test",
        cwd: "/repo",
        remoteRequestId: "remote-1",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { approval: { id: string; orphaned: boolean } };
    expect(createdBody.approval.orphaned).toBe(true);

    const list = await app.request("/api/bash-approvals?includeOrphans=1");
    const listBody = (await list.json()) as { approvals: Array<{ id: string }> };
    expect(listBody.approvals).toEqual([expect.objectContaining({ id: createdBody.approval.id })]);

    const approve = await app.request(`/api/bash-approvals/${createdBody.approval.id}/approve`, {
      method: "POST",
    });
    expect(approve.status).toBe(200);
  });
});
