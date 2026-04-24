import { createHash } from "node:crypto";

export type ChromeVisitContentKeyInput = {
  url: string;
  visit_time: number;
  transition: number | null;
  visit_duration: number | null;
};

export function chromeVisitContentKey(v: ChromeVisitContentKeyInput): string {
  const raw = JSON.stringify([
    "chrome-visit-v1",
    v.url,
    v.visit_time,
    v.transition ?? null,
    v.visit_duration ?? null,
  ]);
  return createHash("sha256").update(raw).digest("hex");
}
