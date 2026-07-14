// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaxonomyEditor } from "../web/src/pages/settings/TaxonomyEditor";

const MINE = {
  name: "自建·Homelab",
  color: "#5ec8a0",
  rules: [{ kind: "domainSuffix", value: "truenas.com" }],
};
const BUILTIN = { name: "前端·UI", color: "#4f9dff", rules: [{ kind: "domainSuffix", value: "react.dev" }] };

function payload(over: Record<string, unknown> = {}) {
  return {
    source: "file",
    gapMinutes: 30,
    own: [MINE],
    builtin: [BUILTIN],
    otherCategory: "其他",
    ...over,
  };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function renderEditor() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TaxonomyEditor />
    </QueryClientProvider>
  );
}

describe("TaxonomyEditor", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows your categories as editable and the built-ins as a separate read-only list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(payload())));
    renderEditor();

    expect(await screen.findByText("我的分类")).toBeInTheDocument();
    expect(screen.getByText("内置（1）")).toBeInTheDocument();
    // Selected by default → its rule is editable on the right.
    expect(await screen.findByLabelText("分类名")).toHaveValue("自建·Homelab");
    expect(screen.getByLabelText("规则值")).toHaveValue("truenas.com");
    // While it is still coming from the file, say so — and say the file survives.
    expect(screen.getByText(/config\.json/)).toBeInTheDocument();
  });

  it("saves ONLY your own categories — never the built-ins merged back in", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          sent.push(JSON.parse(String(init.body)));
          return json(payload({ source: "db" }));
        }
        // Already owned by settings, so the button reads 保存 (before takeover it
        // reads 接管配置 — same payload either way).
        return json(payload({ source: "db" }));
      })
    );
    const user = userEvent.setup();
    renderEditor();

    const value = await screen.findByLabelText("规则值");
    await user.clear(value);
    await user.type(value, "unraid.net");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(sent).toHaveLength(1);
    const body = sent[0] as { categories: Array<{ name: string }>; gapMinutes: number };
    // The built-in must NOT be in the payload: saving it would freeze it into the
    // user's config and cut them off from future updates to the built-in list.
    expect(body.categories.map((c) => c.name)).toEqual(["自建·Homelab"]);
    expect(body.categories[0]).toMatchObject({
      rules: [{ kind: "domainSuffix", value: "unraid.net" }],
    });
    expect(body.gapMinutes).toBe(30);
  });

  it("「覆盖」 copies a built-in into your own set so it can be edited", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(payload())));
    const user = userEvent.setup();
    renderEditor();

    await screen.findByText("我的分类");
    await user.click(screen.getByRole("button", { name: "覆盖" }));

    // It is now yours, selected, and its rules are editable.
    expect(await screen.findByLabelText("分类名")).toHaveValue("前端·UI");
    expect(screen.getByLabelText("规则值")).toHaveValue("react.dev");
  });

  it("while the config still lives in the file, saving is live with no edits — it IS the takeover", async () => {
    // Gating this on "has the user edited something" made the one action a
    // file-using user actually needs unreachable: they open the page, everything
    // is correct already, and the only button is greyed out.
    vi.stubGlobal("fetch", vi.fn(async () => json(payload({ source: "file" }))));
    renderEditor();

    const btn = await screen.findByRole("button", { name: "接管配置" });
    expect(btn).toBeEnabled();
  });

  it("once settings owns it, the save button waits for an actual change", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(payload({ source: "db" }))));
    const user = userEvent.setup();
    renderEditor();

    const saveBtn = await screen.findByRole("button", { name: "保存" });
    expect(saveBtn).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "新增规则" }));
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  });
});
