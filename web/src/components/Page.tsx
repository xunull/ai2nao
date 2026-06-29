import type { ReactNode } from "react";

type PageProps = {
  title: string;
  subtitle?: string;
  /** Right-aligned controls in the header (refresh, primary action…). */
  actions?: ReactNode;
  /**
   * Optional pinned strip below the title (metrics, filters, tabs…). It lives
   * in the SAME sticky container as the header, so title + toolbar freeze as
   * one block while `children` scroll beneath — no magic offset. The toolbar's
   * own content owns its bottom spacing (it sits flush against the frozen
   * block's bottom border).
   */
  toolbar?: ReactNode;
  children: ReactNode;
};

/**
 * Shared page frame: a sticky header (+ optional toolbar) pinned to the top of
 * the app scroll container (Layout's <main>), with content scrolling beneath.
 *
 * Thin by design — it does NOT own scroll or max-width; those stay on Layout's
 * <main> wrapper so pages not yet migrated keep their framing. The frozen block
 * uses `-mt-5` to cancel the wrapper's top padding (pins flush to the top) and
 * `-mx-8` to bleed the bottom border to the frame edge (max-w-[1760px]).
 *
 * Note: a migrated page that ALSO has an internal `thead`/element with
 * `sticky top-0` must offset it so it sticks below this frozen block instead of
 * being hidden behind it.
 */
export function Page({ title, subtitle, actions, toolbar, children }: PageProps) {
  return (
    <div>
      <div className="sticky top-0 z-20 -mx-8 -mt-5 border-b border-[var(--border)] bg-[var(--bg)]/85 backdrop-blur">
        <header className="flex items-end justify-between gap-3 px-8 py-3">
          <div>
            <h1 className="text-xl font-semibold">{title}</h1>
            {subtitle ? (
              <p className="mt-0.5 text-sm text-[var(--muted)]">{subtitle}</p>
            ) : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </header>
        {toolbar ? <div className="px-8">{toolbar}</div> : null}
      </div>
      <div className="pt-5">{children}</div>
    </div>
  );
}
