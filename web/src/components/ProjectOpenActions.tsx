import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { apiPost } from "../api";
import { cardToolReveal, reducedCardToolReveal } from "../motion/presets";

export type ProjectOpenerId = "vscode" | "cursor" | "warp" | "iterm2";

type ProjectOpenActionsProps = {
  path: string;
  openers?: ProjectOpenerId[];
  size?: "sm" | "md";
};

const DEFAULT_OPENERS: ProjectOpenerId[] = ["vscode", "cursor", "warp", "iterm2"];

const OPENER_LABELS: Record<ProjectOpenerId, string> = {
  vscode: "VS Code",
  cursor: "Cursor",
  warp: "Warp",
  iterm2: "iTerm2",
};

type OpenProjectResponse = {
  ok: true;
  opener: ProjectOpenerId;
  path: string;
};

export function ProjectOpenActions({
  path,
  openers = DEFAULT_OPENERS,
  size = "sm",
}: ProjectOpenActionsProps) {
  const [focusWithin, setFocusWithin] = useState(false);
  const shouldReduceMotion = useReducedMotion();
  const mutation = useMutation({
    mutationFn: (opener: ProjectOpenerId) =>
      apiPost<OpenProjectResponse>("/api/project-openers/open", { opener, path }),
  });
  const activeOpener = mutation.variables;
  const buttonSize = size === "md" ? "h-8 w-8" : "h-7 w-7";
  const iconSize = size === "md" ? "h-4 w-4" : "h-[15px] w-[15px]";

  if (!path.trim()) return null;

  return (
    <motion.div
      className="min-w-0"
      variants={shouldReduceMotion ? reducedCardToolReveal : cardToolReveal}
      animate={focusWithin ? "active" : undefined}
      whileHover="active"
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false);
      }}
      data-project-open-actions
    >
      <div className="flex items-center gap-1.5" aria-label="打开项目">
        {openers.map((opener) => {
          const label = OPENER_LABELS[opener];
          const pending = mutation.isPending && activeOpener === opener;
          return (
            <button
              key={opener}
              type="button"
              title={`用 ${label} 打开项目`}
              aria-label={`用 ${label} 打开项目`}
              disabled={mutation.isPending}
              onClick={(event) => {
                event.stopPropagation();
                mutation.mutate(opener);
              }}
              className={`${buttonSize} inline-flex shrink-0 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-700 shadow-sm transition hover:border-neutral-300 hover:bg-neutral-50 disabled:cursor-wait disabled:opacity-60`}
            >
              <ProjectOpenerIcon opener={opener} className={iconSize} pending={pending} />
            </button>
          );
        })}
      </div>
      {mutation.isError && (
        <div className="mt-1 max-w-[13rem] truncate text-[11px] text-red-700" role="alert">
          {(mutation.error as Error).message}
        </div>
      )}
    </motion.div>
  );
}

function ProjectOpenerIcon({
  opener,
  className,
  pending,
}: {
  opener: ProjectOpenerId;
  className: string;
  pending: boolean;
}) {
  const spin = pending ? " animate-spin" : "";
  if (opener === "vscode") {
    return (
      <svg className={`${className}${spin}`} viewBox="0 0 24 24" role="img" aria-hidden="true">
        <path fill="#007ACC" d="M17.9 2.3 9 10.6 3.7 6.5 2 7.4v9.2l1.7.9L9 13.4l8.9 8.3L22 20V4l-4.1-1.7Z" />
        <path fill="#1F9CF0" d="M17.9 7.8v8.4L12.5 12l5.4-4.2Z" />
      </svg>
    );
  }
  if (opener === "cursor") {
    return (
      <svg className={`${className}${spin}`} viewBox="0 0 24 24" role="img" aria-hidden="true">
        <path fill="#111827" d="M4 2.8 20.8 12 14 14.1l-2.2 6.7L4 2.8Z" />
        <path fill="#FFFFFF" d="m8.6 7.2 7.2 4-3.8 1.2-1.2 3.7-2.2-8.9Z" />
      </svg>
    );
  }
  if (opener === "warp") {
    return (
      <svg className={`${className}${spin}`} viewBox="0 0 24 24" role="img" aria-hidden="true">
        <rect width="24" height="24" rx="5" fill="#01A4FF" />
        <path fill="#FFFFFF" d="M5.2 7h3l1.7 7.2L12 7h2.3l2.1 7.2L18.1 7h2.7l-3 10h-2.7l-2-6.4-2 6.4H8.2l-3-10Z" />
      </svg>
    );
  }
  return (
    <svg className={`${className}${spin}`} viewBox="0 0 24 24" role="img" aria-hidden="true">
      <rect x="2.5" y="4" width="19" height="16" rx="3" fill="#111827" />
      <path fill="#22C55E" d="m6.2 9.1 3.2 2.9-3.2 2.9-1.1-1.2 1.9-1.7-1.9-1.7 1.1-1.2Z" />
      <path fill="#E5E7EB" d="M10.5 15h6.8v1.5h-6.8z" />
    </svg>
  );
}
