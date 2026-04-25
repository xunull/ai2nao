const DEFAULT_MAX_Q_LEN = 400;
const DEFAULT_MAX_LIMIT = 100;

export type ListQueryOptions = {
  q?: string;
  includeMissing: boolean;
  limit: number;
  offset: number;
};

export type ListQueryConfig = {
  defaultLimit?: number;
  maxLimit?: number;
  maxQLength?: number;
  maxOffset?: number;
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
  return {
    q,
    includeMissing,
    limit: Math.min(maxLimit, limitParsed),
    offset: offsetParsed,
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
