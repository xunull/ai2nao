// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BashPermissions } from "../web/src/pages/BashPermissions";

type Rule = {
  id: string;
  behavior: "allow" | "ask" | "deny";
  ruleType: "exact" | "prefix" | "wildcard";
  ruleContent: string;
  scopeType: "global" | "directory";
  scopeValue: string;
  source: "user" | "suggested" | "remote" | "system";
  note: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  useCount: number;
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BashPermissions />
    </QueryClientProvider>
  );
}

describe("BashPermissions page", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("groups allowed shell rules by directory and shows global rules separately", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/bash-permission-rules?behavior=allow")) {
          return json({
            rules: [
              rule({
                id: "r1",
                behavior: "allow",
                ruleType: "prefix",
                ruleContent: "npm run:*",
                scopeType: "directory",
                scopeValue: "/repo-a",
                useCount: 3,
              }),
              rule({
                id: "r2",
                behavior: "allow",
                ruleType: "exact",
                ruleContent: "git status --short",
                scopeType: "global",
                scopeValue: "",
              }),
            ],
          });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("heading", { name: "Shell 权限" })).toBeInTheDocument();
    expect((await screen.findAllByText("/repo-a")).length).toBeGreaterThan(0);
    expect(await screen.findByText("npm run:*")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /全局/ }));
    expect(await screen.findByText("git status --short")).toBeInTheDocument();
    expect(screen.getByText(/全局规则会在所有目录下参与匹配/)).toBeInTheDocument();
  });

  it("filters by behavior, searches rules, and revokes a saved rule", async () => {
    let allowRules = [
      rule({
        id: "r1",
        behavior: "allow",
        ruleType: "prefix",
        ruleContent: "npm run:*",
        scopeType: "directory",
        scopeValue: "/repo-a",
      }),
    ];
    const allRules = [
      ...allowRules,
      rule({
        id: "r2",
        behavior: "deny",
        ruleType: "exact",
        ruleContent: "npm run deploy",
        scopeType: "directory",
        scopeValue: "/repo-b",
      }),
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/bash-permission-rules?behavior=allow")) {
        return json({ rules: allowRules });
      }
      if (url.endsWith("/api/bash-permission-rules")) {
        return json({ rules: allRules.filter((item) => item.id !== "r1" || allowRules.length > 0) });
      }
      if (url.endsWith("/api/bash-permission-rules/r1") && init?.method === "DELETE") {
        allowRules = [];
        return json({ ok: true });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("npm run:*")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("类型"), "all");
    expect(await screen.findByText("/repo-b")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /repo-b/ }));
    expect(await screen.findByText("npm run deploy")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("搜索目录或命令"));
    await user.type(screen.getByLabelText("搜索目录或命令"), "deploy");
    await waitFor(() => expect(screen.queryByText("/repo-a")).not.toBeInTheDocument());
    expect(screen.getByText("npm run deploy")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("类型"), "allow");
    await user.clear(screen.getByLabelText("搜索目录或命令"));
    expect(await screen.findByText("npm run:*")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "撤销规则" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            String(call[0]).endsWith("/api/bash-permission-rules/r1") &&
            call[1]?.method === "DELETE"
        )
      ).toBe(true)
    );
    await waitFor(() => expect(screen.queryByText("npm run:*")).not.toBeInTheDocument());
    expect(await screen.findByText("暂无匹配的 Shell 权限规则。")).toBeInTheDocument();
  });

  it("creates and edits allow ask deny rules from the management page", async () => {
    let rules = [
      rule({
        id: "r1",
        behavior: "allow",
        ruleType: "prefix",
        ruleContent: "npm run:*",
        scopeType: "directory",
        scopeValue: "/repo-a",
        note: "safe scripts",
        useCount: 2,
        lastUsedAt: "2026-05-23T01:00:00.000Z",
      }),
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/bash-permission-rules?behavior=")) {
        const behavior = new URL(url, "http://x").searchParams.get("behavior");
        return json({ rules: rules.filter((item) => item.behavior === behavior) });
      }
      if (url.endsWith("/api/bash-permission-rules") && !init?.method) {
        return json({ rules });
      }
      if (url.endsWith("/api/bash-permission-rules") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Partial<Rule>;
        const created = rule({
          id: "r2",
          behavior: body.behavior,
          ruleType: body.ruleType,
          ruleContent: body.ruleContent,
          scopeType: body.scopeType,
          scopeValue: body.scopeValue ?? "",
          note: body.note ?? null,
          source: "user",
        } as Partial<Rule>);
        rules = [...rules, created];
        return json({ rule: created });
      }
      if (url.endsWith("/api/bash-permission-rules/r2") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Partial<Rule>;
        const existing = rules.find((item) => item.id === "r2")!;
        const updated = {
          ...existing,
          behavior: body.behavior ?? existing.behavior,
          ruleType: body.ruleType ?? existing.ruleType,
          ruleContent: body.ruleContent ?? existing.ruleContent,
          scopeType: body.scopeType ?? existing.scopeType,
          scopeValue: body.scopeValue ?? existing.scopeValue,
          note: body.note ?? existing.note,
          useCount: existing.useCount,
          lastUsedAt: existing.lastUsedAt,
        };
        rules = rules.map((item) => (item.id === "r2" ? updated : item));
        return json({ rule: updated });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("npm run:*")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "新建规则" }));
    await user.selectOptions(screen.getByLabelText("规则行为"), "deny");
    await user.selectOptions(screen.getByLabelText("匹配方式"), "exact");
    await user.selectOptions(screen.getByLabelText("作用域"), "global");
    await user.type(screen.getByLabelText("命令规则"), "npm run deploy");
    await user.type(screen.getByLabelText("备注"), "block deploys");
    await user.click(screen.getByRole("button", { name: "保存规则" }));

    expect(await screen.findByText("npm run deploy")).toBeInTheDocument();
    expect(screen.getByText("全局规则会在所有目录下参与匹配")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑" }));
    await user.selectOptions(screen.getByLabelText("规则行为"), "ask");
    await user.selectOptions(screen.getByLabelText("作用域"), "directory");
    await user.clear(screen.getByLabelText("命令规则"));
    await user.type(screen.getByLabelText("命令规则"), "pwd");
    await user.type(screen.getByLabelText("目录"), "/repo-b");
    await user.clear(screen.getByLabelText("备注"));
    await user.type(screen.getByLabelText("备注"), "always confirm");
    await user.click(screen.getByRole("button", { name: "保存规则" }));

    expect(await screen.findByText("pwd")).toBeInTheDocument();
    expect((await screen.findAllByText("/repo-b")).length).toBeGreaterThan(0);
    expect(screen.getByText("always confirm")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            String(call[0]).endsWith("/api/bash-permission-rules/r2") &&
            call[1]?.method === "PATCH"
        )
      ).toBe(true)
    );
  });

  it("keeps the rule form open when validation fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/bash-permission-rules?behavior=allow")) {
        return json({ rules: [] });
      }
      if (url.endsWith("/api/bash-permission-rules") && init?.method === "POST") {
        return json({ error: { message: "permission rule already exists" } }, 400);
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "新建规则" }));
    await user.click(screen.getByRole("button", { name: "保存规则" }));
    expect(await screen.findByText("命令规则不能为空。")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("作用域"), "global");
    await user.type(screen.getByLabelText("命令规则"), "pwd");
    await user.click(screen.getByRole("button", { name: "保存规则" }));
    expect(await screen.findByText("permission rule already exists")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存规则" })).toBeInTheDocument();
  });
});

function rule(overrides: Partial<Rule>): Rule {
  return {
    id: "r",
    behavior: "allow",
    ruleType: "exact",
    ruleContent: "pwd",
    scopeType: "directory",
    scopeValue: "/repo",
    source: "suggested",
    note: null,
    enabled: true,
    createdAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:00.000Z",
    lastUsedAt: null,
    useCount: 0,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
