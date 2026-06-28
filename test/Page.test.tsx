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

  it("pins the header to the top of the scroll container", () => {
    const { container } = render(
      <Page title="标题">
        <div>正文</div>
      </Page>
    );
    const header = container.querySelector("header");
    // sticky top-0 pins to the scroll container; -mt-5 cancels the wrapper's
    // top padding so it sits flush at the top from the first frame.
    expect(header?.className).toContain("sticky");
    expect(header?.className).toContain("top-0");
    expect(header?.className).toContain("-mt-5");
  });
});
