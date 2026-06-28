// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { ScrollToTop } from "../web/src/components/ScrollToTop";

afterEach(cleanup);

function Harness({ containerRef }: { containerRef: { current: HTMLElement | null } }) {
  const navigate = useNavigate();
  return (
    <>
      <ScrollToTop containerRef={containerRef} />
      <button onClick={() => navigate("/a?offset=2")}>query</button>
      <button onClick={() => navigate("/b")}>path</button>
    </>
  );
}

describe("ScrollToTop", () => {
  it("resets container scrollTop on pathname change, but NOT on query-only change", () => {
    const el = document.createElement("div");
    const containerRef = { current: el };
    render(
      <MemoryRouter initialEntries={["/a"]}>
        <Harness containerRef={containerRef} />
      </MemoryRouter>
    );

    // Query-only change (?offset=) must preserve scroll position (pagination).
    el.scrollTop = 120;
    fireEvent.click(screen.getByText("query"));
    expect(el.scrollTop).toBe(120);

    // Pathname change must reset to top (new page starts at the top).
    el.scrollTop = 120;
    fireEvent.click(screen.getByText("path"));
    expect(el.scrollTop).toBe(0);
  });

  it("does not throw when the container ref is null", () => {
    const containerRef = { current: null };
    expect(() =>
      render(
        <MemoryRouter initialEntries={["/a"]}>
          <ScrollToTop containerRef={containerRef} />
        </MemoryRouter>
      )
    ).not.toThrow();
  });
});
