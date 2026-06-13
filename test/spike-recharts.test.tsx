// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import React from "react";
void React; // jsx-classic pragma needs React in scope
import { RechartsStackedPartialSpike } from "../web/spike/recharts-stacked-partial";

/**
 * T0 SPIKE assertions — must pass before any other lane starts.
 *
 * Validates Recharts 2.x behavior so we can trust the design doc F1 plan
 * (4 stacked Bar series + SVG pattern fill).
 */
afterEach(() => cleanup());

describe("T0 spike — Recharts stacked partial coverage", () => {
  it("renders 4 <Bar> series sharing stackId='tokens'", () => {
    const { container } = render(<RechartsStackedPartialSpike />);
    // Recharts renders each Bar as a <g class="recharts-bar"> with one <Rectangle>
    // per data point. Each series gets its own <g>; sharing stackId means
    // recharts vertically stacks the rectangles for the same x-coordinate.
    const barGroups = container.querySelectorAll(".recharts-bar");
    expect(barGroups.length).toBe(4);
  });

  it("defines <pattern id='hatch-claude'> and 'hatch-codex' in the DOM", () => {
    const { container } = render(<RechartsStackedPartialSpike />);
    expect(container.querySelector("pattern#hatch-claude")).not.toBeNull();
    expect(container.querySelector("pattern#hatch-codex")).not.toBeNull();
  });

  /**
   * NOTE on visual verification:
   *
   * Recharts 2.x in jsdom does not run a layout pass, so every <Bar> rect ends
   * up marked `recharts-inactive-bar` with no `<path fill=url(#...)>` emitted.
   * That's a jsdom limitation, NOT a Recharts API failure — the same component
   * renders fully in a real browser with width/height resolved.
   *
   * So we split the spike's three F1 checkpoints into:
   *   - API-level / Component-level (these unit assertions) — covered above
   *   - Visual-level (pattern fill actually paints) — manual QA before T8 frontend
   *     ships. Open `/dashboard/tokens-trend` in dev server with seeded
   *     mixed-status sessions; partial buckets should show diagonal hatching.
   */
  it("accepts 4 stacked <Bar> + 2 <pattern> defs in the same chart without crashing", () => {
    // If Recharts rejected the prop combination this would have thrown during
    // render; the fact that we got here AND prior assertions saw 4 recharts-bar
    // groups AND both <pattern> elements means the API contract holds.
    const { container } = render(<RechartsStackedPartialSpike />);
    expect(container.querySelector(".recharts-wrapper")).not.toBeNull();
    expect(container.querySelectorAll(".recharts-bar").length).toBe(4);
    expect(container.querySelector("pattern#hatch-claude")).not.toBeNull();
    expect(container.querySelector("pattern#hatch-codex")).not.toBeNull();
  });

  it("renders the chart wrapper without crashing", () => {
    const { container } = render(<RechartsStackedPartialSpike />);
    expect(container.querySelector(".recharts-wrapper")).not.toBeNull();
  });
});
