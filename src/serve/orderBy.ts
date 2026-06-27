/**
 * Safe server-side ORDER BY builder for user-driven column sorting.
 *
 * SQLite cannot bind a column name as a parameter, so the sort column MUST come
 * from a developer-authored ALLOWLIST — the user's `sort` value is only ever a
 * KEY lookup, never interpolated into SQL. `dir` is validated to ASC/DESC.
 *
 * Emits:  ORDER BY [<prefix>,] [<expr> IS NULL,] <expr> <DIR>[, <tiebreaker>]
 *   - prefix    : a fixed leading partition kept first (e.g. present-before-removed).
 *   - NULL term : deterministic null placement for nullable columns (col.nulls).
 *   - tiebreaker: a per-table TRULY-unique column for stable pagination order;
 *                 dropped when it equals the chosen sort expr (avoid duplication).
 *
 * Every `expr` / `prefix` / `tiebreaker` is a SQL sink — they are reviewed
 * constants, never user input.
 */

export type SortDir = "asc" | "desc";
export type SortCol = {
  /** Developer-authored column SQL fragment (e.g. "size_bytes", "name COLLATE NOCASE"). */
  expr: string;
  /** Direction used when the user does not specify a valid one. */
  defaultDir?: SortDir;
  /** Deterministic NULL placement for a nullable column. */
  nulls?: "first" | "last";
};

export type OrderByInput = {
  sort?: string;
  dir?: SortDir;
  allowed: Record<string, SortCol>;
  prefix?: string;
  defaultSortKey: string;
  defaultDir: SortDir;
  tiebreaker?: string;
};

function isDir(v: unknown): v is SortDir {
  return v === "asc" || v === "desc";
}

export function orderByClause(input: OrderByInput): string {
  const matched = input.sort != null && Object.prototype.hasOwnProperty.call(input.allowed, input.sort);
  const key = matched ? (input.sort as string) : input.defaultSortKey;
  const col = input.allowed[key];

  // dir is honored only when the user explicitly chose a valid column AND a valid
  // direction; an unknown sort key falls fully back to the column/global default.
  const effectiveDir: SortDir = matched && isDir(input.dir)
    ? input.dir
    : col.defaultDir ?? input.defaultDir;
  const DIR = effectiveDir.toUpperCase();

  const terms: string[] = [];
  if (input.prefix) terms.push(input.prefix);
  if (col.nulls === "last") terms.push(`${col.expr} IS NULL`);
  else if (col.nulls === "first") terms.push(`${col.expr} IS NOT NULL`);
  terms.push(`${col.expr} ${DIR}`);
  if (input.tiebreaker && input.tiebreaker !== col.expr) terms.push(input.tiebreaker);

  return `ORDER BY ${terms.join(", ")}`;
}
