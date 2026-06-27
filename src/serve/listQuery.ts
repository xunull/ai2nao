const DEFAULT_MAX_Q_LEN = 400;
const DEFAULT_MAX_LIMIT = 100;

export type ListQueryOptions = {
  q?: string;
  includeMissing: boolean;
  limit: number;
  offset: number;
  /** Raw sort key — table-agnostic here; validated against a per-table allowlist downstream. */
  sort?: string;
  /** Validated sort direction; undefined when absent or malformed. */
  dir?: "asc" | "desc";
};

export type ListQueryConfig = {
  defaultLimit?: number;
  maxLimit?: number;
  maxQLength?: number;
  maxOffset?: number;
  /** Cap for the raw sort key length (defense in depth; the allowlist is the real gate). */
  maxSortLength?: number;
};

export function parseListQuery(
  query: (key: string) => string | undefined,
  config: ListQueryConfig = {}
): ListQueryOptions | { error: string } {
  const maxQLength = config.maxQLength ?? DEFAULT_MAX_Q_LEN;
  const maxLimit = config.maxLimit ?? DEFAULT_MAX_LIMIT;
  const defaultLimit = config.defaultLimit ?? 50;
  const maxOffset = config.maxOffset ?? 1_000_000;
  const q = cleanOptionalString(query("q"));
  if (q && q.length > maxQLength) return { error: "query too long" };
  const limitParsed = parseNonNegativeInt(query("limit") ?? String(defaultLimit));
  const offsetParsed = parseNonNegativeInt(query("offset") ?? "0");
  if (limitParsed == null || limitParsed < 1) return { error: "invalid limit" };
  if (offsetParsed == null || offsetParsed < 0 || offsetParsed > maxOffset) {
    return { error: "invalid offset" };
  }
  const includeRaw = query("includeMissing");
  const includeMissing = includeRaw === "1" || includeRaw === "true";
  // sort: raw key only (the allowlist downstream is the real validation). Cap length
  // as cheap defense in depth. dir: validated here to the asc/desc union.
  const maxSortLength = config.maxSortLength ?? 64;
  const sortRaw = cleanOptionalString(query("sort"));
  const sort = sortRaw && sortRaw.length <= maxSortLength ? sortRaw : undefined;
  const dirRaw = query("dir");
  const dir = dirRaw === "asc" || dirRaw === "desc" ? dirRaw : undefined;
  return {
    q,
    includeMissing,
    limit: Math.min(maxLimit, limitParsed),
    offset: offsetParsed,
    sort,
    dir,
  };
}

export function cleanOptionalString(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : undefined;
}

function parseNonNegativeInt(v: string): number | null {
  const t = v.trim();
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}
