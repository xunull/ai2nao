import { describe, expect, it } from "vitest";
import {
  CORE_TRANSITION,
  QUALIFIER,
  coreTransition,
  isNoiseVisit,
} from "../src/topicStream/transition.js";

// Chrome PAGE_TRANSITION values are a uint32: low byte = core type, high bits =
// qualifier flags. Verify the bit decode against real-ish composite values,
// including ones with the sign bit (SERVER_REDIRECT 0x80000000) set that would
// trip up naive int handling.
describe("topicStream transition decode", () => {
  it("decodes the core type from the low byte", () => {
    expect(coreTransition(0)).toBe("link");
    expect(coreTransition(1)).toBe("typed");
    expect(coreTransition(5)).toBe("generated");
    expect(coreTransition(7)).toBe("form_submit");
    expect(coreTransition(8)).toBe("reload");
    expect(coreTransition(9)).toBe("keyword");
  });

  it("reads the core type even when high qualifier bits are set", () => {
    // TYPED (1) + FROM_ADDRESS_BAR + SERVER_REDIRECT(sign bit)
    const t = 1 | QUALIFIER.FROM_ADDRESS_BAR | 0x80000000;
    expect(coreTransition(t)).toBe("typed");
  });

  it("maps NULL/undefined transition to unknown", () => {
    expect(coreTransition(null)).toBe("unknown");
    expect(coreTransition(undefined)).toBe("unknown");
  });

  it("drops RELOAD core visits as noise", () => {
    expect(isNoiseVisit(8)).toBe(true);
    // RELOAD with a redirect qualifier still counts as reload noise.
    expect(isNoiseVisit(8 | 0x80000000)).toBe(true);
  });

  it("drops FORWARD_BACK visits as noise regardless of core type", () => {
    expect(isNoiseVisit(0 | QUALIFIER.FORWARD_BACK)).toBe(true); // link + back
    expect(isNoiseVisit(1 | QUALIFIER.FORWARD_BACK)).toBe(true); // typed + back
  });

  it("keeps intentional navigation (typed/link/bookmark/form/keyword)", () => {
    expect(isNoiseVisit(1)).toBe(false); // typed
    expect(isNoiseVisit(0)).toBe(false); // link
    expect(isNoiseVisit(2)).toBe(false); // auto_bookmark
    expect(isNoiseVisit(7)).toBe(false); // form_submit
    expect(isNoiseVisit(9)).toBe(false); // keyword
  });

  it("keeps NULL transition (unknown) rather than dropping it", () => {
    expect(isNoiseVisit(null)).toBe(false);
    expect(isNoiseVisit(undefined)).toBe(false);
  });
});
