/** Human-readable file size (B / KB / MB / …). */
export function formatByteSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  if (bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  const fraction = u === 0 ? 0 : n >= 100 ? 0 : n >= 10 ? 1 : 2;
  return `${n.toFixed(fraction)} ${units[u]}`;
}

/** Local wall-clock time from epoch ms (for file birth/mtime). */
export function formatFileTimeMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Compact human-readable token count for dashboard metrics. */
export function formatTokenCount(tokens: number | null | undefined): string {
  if (tokens == null || !Number.isFinite(tokens) || tokens < 0) return "—";
  if (tokens < 1000) return Math.trunc(tokens).toLocaleString("en-US");
  if (tokens < 1_000_000) {
    const value = tokens / 1000;
    const fraction = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(fraction)}K`;
  }
  const value = tokens / 1_000_000;
  const fraction = value >= 100 ? 0 : 1;
  return `${value.toFixed(fraction)}M`;
}

export function formatTokenCoverage(
  coverage: "full" | "partial" | "unknown" | null | undefined
): string {
  if (coverage === "full") return "真实 token";
  if (coverage === "partial") return "部分 token";
  return "token 未知";
}
