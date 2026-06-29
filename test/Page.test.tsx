// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { Page } from "../web/src/components/Page";

afterEach(cleanup);

describe("Page frame", () => {
  it("renders title, subtitle and actions", () => {
    render(
      <Page title="定时任务" subtitle="统一管理本机任务" actions={<button>刷新</button>}>
        <div>内容</div>
      </Page>
    );
    expect(screen.getByRole("heading", { name: "定时任务" })).toBeInTheDocument();
    expect(screen.getByText("统一管理本机任务")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
    expect(screen.getByText("内容")).toBeInTheDocument();
  });

  it("omits subtitle and actions when not provided", () => {
    render(
      <Page title="仅标题">
        <div>正文</div>
      </Page>
    );
    expect(screen.getByRole("heading", { name: "仅标题" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders the toolbar inside the same sticky frozen block as the header", () => {
    const { container } = render(
      <Page title="定时任务" toolbar={<div data-testid="metrics">已注册 16</div>}>
        <div>任务列表</div>
      </Page>
    );
    const frozen = container.querySelector("header")?.parentElement;
    // header + toolbar share one sticky container → freeze as a unit.
    expect(frozen?.className).toContain("sticky");
    expect(frozen?.className).toContain("top-0");
    expect(frozen?.querySelector('[data-testid="metrics"]')).toBeInTheDocument();
  });

  it("omits the toolbar block when no toolbar is given", () => {
    const { container } = render(
      <Page title="无工具条">
        <div>正文</div>
      </Page>
    );
    const frozen = container.querySelector("header")?.parentElement;
    // only the header child, no extra toolbar div.
    expect(frozen?.children).toHaveLength(1);
  });

  it("pins the frozen block to the top of the scroll container", () => {
    const { container } = render(
      <Page title="标题">
        <div>正文</div>
      </Page>
    );
    // The frozen block (header's parent) carries sticky top-0; -mt-5 cancels the
    // wrapper's top padding so it sits flush at the top from the first frame.
    const frozen = container.querySelector("header")?.parentElement;
    expect(frozen?.className).toContain("sticky");
    expect(frozen?.className).toContain("top-0");
    expect(frozen?.className).toContain("-mt-5");
  });
});
