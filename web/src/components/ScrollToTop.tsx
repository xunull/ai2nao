import { useLayoutEffect, type RefObject } from "react";
import { useLocation } from "react-router-dom";

/**
 * Resets the app scroll container to the top on route change.
 *
 * The scroll container lives in Layout's <main> and is NOT unmounted when the
 * route changes, so without this the new page would inherit the previous page's
 * scroll offset (user lands mid-page). react-router has no built-in scroll
 * restoration for a custom scroll container.
 *
 * Keyed on `pathname` only — query-string changes (e.g. `?offset=` pagination,
 * `?q=` search) must NOT scroll the list back to the top. `useLayoutEffect`
 * resets before paint so there is no flash of the old scroll position.
 */
export function ScrollToTop({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    // Use scrollTop/scrollLeft (plain settable props) rather than scrollTo() —
    // scrollTo is absent on elements in jsdom and would throw under test.
    const el = containerRef.current;
    if (el) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
  }, [pathname, containerRef]);
  return null;
}
