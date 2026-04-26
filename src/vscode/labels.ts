import type { VscodeAppId } from "./types.js";

const LABELS: Record<VscodeAppId, string> = {
  code: "VS Code",
  "code-insiders": "VS Code Insiders",
  vscodium: "VSCodium",
  cursor: "Cursor",
};

export function vscodeAppLabel(app: VscodeAppId): string {
  return LABELS[app];
}
