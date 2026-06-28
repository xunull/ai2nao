import type { ReactNode } from "react";

type PageProps = {
  title: string;
  subtitle?: string;
  /** Right-aligned controls in the header (refresh, primary action…). */
  actions?: ReactNode;
  children: ReactNode;
};

/**
 * Shared page frame: a sticky header pinned to the top of the app scroll
 * container (Layout's <main>), with content scrolling beneath it.
 *
 * Thin by design — it does NOT own scroll or max-width; those stay on Layout's
 * <main> wrapper so pages not yet migrated keep their framing. The header uses
 * `-mt-5` to cancel the wrapper's top padding (pins flush to the top) and
 * `-mx-8` to bleed the bottom border to the frame edge (max-w-[1760px]).
 *
 * Note: a migrated page that ALSO has an internal `thead`/element with
 * `sticky top-0` must offset it (e.g. `top-[57px]`) so it sticks below this
 * header instead of being hidden behind it.
 */
export function Page({ title, subtitle, actions, children }: PageProps) {
  return (
    <div>
      <header className="sticky top-0 z-20 -mx-8 -mt-5 flex items-end justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg)]/85 px-8 py-3 backdrop-blur">
        <div>
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle ? (
            <p className="mt-0.5 text-sm text-[var(--muted)]">{subtitle}</p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className="pt-5">{children}</div>
    </div>
  );
}
