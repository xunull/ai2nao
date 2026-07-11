/**
 * Chrome `PAGE_TRANSITION` bit decode.
 *
 * A visit's `transition` is a uint32: the low byte is the "core" navigation
 * type, the high bits are qualifier flags. See Chromium
 * `ui/base/page_transition_types.h`.
 *
 *   transition = CORE (0..10)  |  QUALIFIER flags (0x????00)
 *
 * JS bitwise ops coerce to int32, but ToInt32 preserves the low 32 bits'
 * pattern, so `& 0xFF` and `& 0x0100_0000` read the right bits even when the
 * SERVER_REDIRECT sign bit (0x8000_0000) is set. That is exercised by the tests.
 *
 * Stage 1 noise filter: drop `RELOAD` core visits and any `FORWARD_BACK` visit.
 * These are the only kinds Chrome's transition field can express reliably. It
 * does NOT mark session-restore / background-tab reopens (those masquerade as
 * RELOAD/LINK), so we do not claim to filter them — see the design doc premise 3.
 */

export const CORE_MASK = 0xff;

export const CORE = {
  LINK: 0,
  TYPED: 1,
  AUTO_BOOKMARK: 2,
  AUTO_SUBFRAME: 3,
  MANUAL_SUBFRAME: 4,
  GENERATED: 5,
  AUTO_TOPLEVEL: 6,
  FORM_SUBMIT: 7,
  RELOAD: 8,
  KEYWORD: 9,
  KEYWORD_GENERATED: 10,
} as const;

export const QUALIFIER = {
  FORWARD_BACK: 0x01000000,
  FROM_ADDRESS_BAR: 0x02000000,
  HOME_PAGE: 0x04000000,
  FROM_API: 0x08000000,
  CHAIN_START: 0x10000000,
  CHAIN_END: 0x20000000,
  CLIENT_REDIRECT: 0x40000000,
  SERVER_REDIRECT: 0x80000000,
} as const;

export type CoreTransition =
  | "link"
  | "typed"
  | "auto_bookmark"
  | "auto_subframe"
  | "manual_subframe"
  | "generated"
  | "auto_toplevel"
  | "form_submit"
  | "reload"
  | "keyword"
  | "keyword_generated"
  | "unknown";

const CORE_NAME: Record<number, CoreTransition> = {
  0: "link",
  1: "typed",
  2: "auto_bookmark",
  3: "auto_subframe",
  4: "manual_subframe",
  5: "generated",
  6: "auto_toplevel",
  7: "form_submit",
  8: "reload",
  9: "keyword",
  10: "keyword_generated",
};

/** Core navigation type, or `"unknown"` when the transition is NULL/undefined. */
export function coreTransition(transition: number | null | undefined): CoreTransition {
  if (transition == null) return "unknown";
  return CORE_NAME[transition & CORE_MASK] ?? "unknown";
}

/**
 * True when a visit should be dropped from the Stage 1 topic river as noise:
 * a RELOAD core type, or any FORWARD_BACK-qualified navigation. NULL transition
 * is treated as `unknown` and KEPT (we do not silently drop rows we cannot read).
 */
export function isNoiseVisit(transition: number | null | undefined): boolean {
  if (transition == null) return false;
  if ((transition & CORE_MASK) === CORE.RELOAD) return true;
  if ((transition & QUALIFIER.FORWARD_BACK) !== 0) return true;
  return false;
}
