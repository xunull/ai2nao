// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BashSandboxSettings } from "../web/src/pages/BashSandboxSettings";

type Config = {
  version: 1;
  mode: "off" | "best-effort" | "required";
  filesystem: {
    allowWrite: string[];
    denyWrite: string[];
    denyRead: string[];
    allowRead: string[];
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
  };
};

type Status = {
  configPath: string;
  configured: boolean;
  config: Config;
  effectivePolicy: Pick<Config, "filesystem" | "network">;
  dependencies: {
    supportedPlatform: boolean;
    ok: boolean;
    warnings: string[];
    errors: string[];
  };
  error: string | null;
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BashSandboxSettings />
    </QueryClientProvider>
  );
}

describe("BashSandboxSettings page", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads sandbox status and saves edited policies", async () => {
    let status = statusPayload();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/bash-sandbox/status")) {
        return json(status);
      }
      if (url.endsWith("/api/bash-sandbox/config") && init?.method === "POST") {
        status = { ...status, configured: true, config: JSON.parse(String(init.body)) as Config };
        return json(status);
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("heading", { name: "Shell 沙箱" })).toBeInTheDocument();
    expect(await screen.findByText("/tmp/bash-sandbox.json")).toBeInTheDocument();
    expect(screen.getByText("当前平台支持")).toBeInTheDocument();
    expect(screen.getByLabelText("允许写入")).toHaveValue("/repo\n/tmp");

    await user.click(screen.getByRole("button", { name: /强制沙箱/ }));
    await user.clear(screen.getByLabelText("允许域名"));
    await user.type(screen.getByLabelText("允许域名"), "api.github.com");
    await user.click(screen.getByRole("button", { name: "保存配置" }));

    await screen.findByText("配置已保存。");
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => {
          if (!String(call[0]).endsWith("/api/bash-sandbox/config")) return false;
          const body = JSON.parse(String(call[1]?.body)) as Config;
          return body.mode === "required" && body.network.allowedDomains[0] === "api.github.com";
        })
      ).toBe(true)
    );
  });

  it("shows dependency and config errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/bash-sandbox/status")) {
          return json({
            ...statusPayload(),
            error: "invalid json",
            dependencies: {
              supportedPlatform: false,
              ok: false,
              warnings: ["seccomp missing"],
              errors: ["unsupported platform"],
            },
          });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderPage();

    expect(await screen.findByText("invalid json")).toBeInTheDocument();
    expect(screen.getByText("unsupported platform")).toBeInTheDocument();
    expect(screen.getByText("seccomp missing")).toBeInTheDocument();
  });
});

function statusPayload(): Status {
  return {
    configPath: "/tmp/bash-sandbox.json",
    configured: false,
    config: {
      version: 1,
      mode: "off",
      filesystem: {
        allowWrite: ["/repo", "/tmp"],
        denyWrite: [".env"],
        denyRead: ["~/.ssh"],
        allowRead: ["/repo"],
      },
      network: {
        allowedDomains: [],
        deniedDomains: [],
      },
    },
    effectivePolicy: {
      filesystem: {
        allowWrite: ["/repo", "/tmp"],
        denyWrite: [".env"],
        denyRead: ["~/.ssh"],
        allowRead: ["/repo"],
      },
      network: {
        allowedDomains: [],
        deniedDomains: [],
      },
    },
    dependencies: {
      supportedPlatform: true,
      ok: true,
      warnings: [],
      errors: [],
    },
    error: null,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
