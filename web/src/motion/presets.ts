import type { Variants } from "motion/react";

export const subtleTransition = {
  duration: 0.16,
  ease: "easeOut",
} as const;

export const cardToolReveal: Variants = {
  idle: {
    opacity: 0.32,
    scale: 0.98,
    transition: subtleTransition,
  },
  parentHover: {
    opacity: 0.62,
    scale: 1,
    transition: subtleTransition,
  },
  active: {
    opacity: 1,
    scale: 1,
    transition: subtleTransition,
  },
};

export const reducedCardToolReveal: Variants = {
  idle: {
    opacity: 0.42,
    transition: subtleTransition,
  },
  parentHover: {
    opacity: 0.7,
    transition: subtleTransition,
  },
  active: {
    opacity: 1,
    transition: subtleTransition,
  },
};
