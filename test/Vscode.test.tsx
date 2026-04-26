// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorProjects } from "../web/src/pages/CursorProjects";
import { Vscode } from "../web/src/pages/Vscode";

function renderPage(page = <Vscode />) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      {page}
    </QueryClientProvider>
  );
}

describe("VS Code page", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders remote entries without raw remote host or user", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/vscode/status?app=code")) {
          return new Response(
            JSON.stringify({
              app: "code",
              supported: true,
              statePath: "/tmp/state.vscdb",
              exists: true,
              counts: { total: 1, active: 1, missing: 0, remote: 1 },
              lastSeenAt: "2026-04-25T00:00:00.000Z",
            })
          );
        }
        if (url.includes("/api/vscode/recent-projects")) {
          return new Response(
            JSON.stringify({
              rows: [
                {
                  key: "remote:ssh-remote:abc123:def456",
                  label: "private",
                  path: null,
                  repo: null,
                  entryCount: 1,
                  latestRecentIndex: 0,
                  kind: "folder",
                  remoteType: "ssh-remote",
                  remoteAuthorityHash: "abc123",
                  missing: false,
                },
              ],
              total: 1,
              limit: 50,
              offset: 0,
            })
          );
        }
        if (url.includes("/api/vscode/recent")) {
          return new Response(
            JSON.stringify({
              rows: [
                {
                  id: 1,
                  kind: "folder",
                  recent_index: 0,
                  uri_redacted: "ssh-remote://abc123/def456",
                  path: null,
                  label: "private",
                  remote_type: "ssh-remote",
                  remote_authority_hash: "abc123",
                  exists_on_disk: null,
                  missing_since: null,
                },
              ],
              total: 1,
              limit: 50,
              offset: 0,
            })
          );
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderPage();

    expect((await screen.findAllByText("private")).length).toBeGreaterThan(0);
    expect(screen.getByText("ssh-remote://abc123/def456")).toBeInTheDocument();
    expect(screen.queryByText(/alice/)).not.toBeInTheDocument();
    expect(screen.queryByText(/example\.com/)).not.toBeInTheDocument();
  });

  it("guards the sync button while a sync request is in flight", async () => {
    let resolveSync!: () => void;
    const pending = new Promise<Response>((resolve) => {
      resolveSync = () => resolve(new Response(JSON.stringify({ ok: true })));
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/vscode/status?app=code")) {
        return new Response(
          JSON.stringify({
            app: "code",
            supported: true,
            statePath: "/tmp/state.vscdb",
            exists: true,
            counts: { total: 0, active: 0, missing: 0, remote: 0 },
            lastSeenAt: null,
          })
        );
      }
      if (url.includes("/api/vscode/recent-projects") || url.includes("/api/vscode/recent")) {
        return new Response(JSON.stringify({ rows: [], total: 0, limit: 50, offset: 0 }));
      }
      if (url.endsWith("/api/vscode/sync") && init?.method === "POST") return pending;
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    const button = await screen.findByRole("button", { name: "立即同步" });
    await user.click(button);
    await user.click(button);

    expect(fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/api/vscode/sync"))).toHaveLength(1);
    expect(await screen.findByRole("button", { name: "同步中…" })).toBeDisabled();
    resolveSync();
  });

  it("renders Cursor copy and sends app=cursor for queries and sync", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/vscode/status?app=cursor")) {
        return new Response(
          JSON.stringify({
            app: "cursor",
            supported: true,
            statePath: "/tmp/cursor/state.vscdb",
            exists: true,
            counts: { total: 0, active: 0, missing: 0, remote: 0 },
            lastSeenAt: null,
          })
        );
      }
      if (url.includes("/api/vscode/recent-projects?")) {
        expect(url).toContain("app=cursor");
        return new Response(JSON.stringify({ rows: [], total: 0, limit: 50, offset: 0 }));
      }
      if (url.includes("/api/vscode/recent?")) {
        expect(url).toContain("app=cursor");
        return new Response(JSON.stringify({ rows: [], total: 0, limit: 50, offset: 0 }));
      }
      if (url.endsWith("/api/vscode/sync") && init?.method === "POST") {
        expect(init.body).toBe(JSON.stringify({ app: "cursor" }));
        return new Response(JSON.stringify({ ok: true }));
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    renderPage(<CursorProjects />);

    expect(await screen.findByText("Cursor 打开项目")).toBeInTheDocument();
    expect(await screen.findByText(/Cursor 最近记录/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "同步 Cursor 项目" }));

    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith("/api/vscode/sync"))).toBe(true);
  });
});
