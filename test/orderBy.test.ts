import { describe, expect, it } from "vitest";
import { orderByClause, type SortCol } from "../src/serve/orderBy.js";

// HF-shaped config (the canary): default reproduces the existing fixed ORDER BY.
const HF = {
  allowed: {
    size: { expr: "size_bytes", defaultDir: "desc" },
    name: { expr: "repo_id COLLATE NOCASE", defaultDir: "asc" },
  } as Record<string, SortCol>,
  prefix: "missing_since IS NOT NULL",
  defaultSortKey: "size",
  defaultDir: "desc" as const,
  tiebreaker: "repo_id COLLATE NOCASE",
};

describe("orderByClause", () => {
  it("no sort param reproduces the existing default ORDER BY byte-for-byte", () => {
    expect(orderByClause({ ...HF })).toBe(
      "ORDER BY missing_since IS NOT NULL, size_bytes DESC, repo_id COLLATE NOCASE"
    );
  });

  it("honors a valid sort key + valid direction", () => {
    expect(orderByClause({ ...HF, sort: "size", dir: "asc" })).toBe(
      "ORDER BY missing_since IS NOT NULL, size_bytes ASC, repo_id COLLATE NOCASE"
    );
  });

  it("uses the column's defaultDir when dir is omitted", () => {
    // name.defaultDir = asc
    expect(orderByClause({ ...HF, sort: "name" })).toBe(
      "ORDER BY missing_since IS NOT NULL, repo_id COLLATE NOCASE ASC"
    );
  });

  it("dedupes the tiebreaker when it equals the sort column", () => {
    // sorting by name (repo_id) -> tiebreaker repo_id would duplicate; drop it.
    expect(orderByClause({ ...HF, sort: "name", dir: "desc" })).toBe(
      "ORDER BY missing_since IS NOT NULL, repo_id COLLATE NOCASE DESC"
    );
  });

  it("falls back to default for an unknown sort key (no user SQL leaks)", () => {
    const out = orderByClause({ ...HF, sort: "size_bytes; DROP TABLE x", dir: "asc" });
    expect(out).toBe(
      "ORDER BY missing_since IS NOT NULL, size_bytes DESC, repo_id COLLATE NOCASE"
    );
    expect(out).not.toContain("DROP");
  });

  it("ignores an invalid direction (uses column default)", () => {
    expect(orderByClause({ ...HF, sort: "size", dir: "sideways" as never })).toBe(
      "ORDER BY missing_since IS NOT NULL, size_bytes DESC, repo_id COLLATE NOCASE"
    );
  });

  it("emits a NULL-placement term for a nullable column (nulls:last)", () => {
    const cfg = {
      allowed: { date: { expr: "last_modified_ms", defaultDir: "desc", nulls: "last" } } as Record<string, SortCol>,
      defaultSortKey: "date",
      defaultDir: "desc" as const,
      tiebreaker: "repo_id",
    };
    expect(orderByClause({ ...cfg, sort: "date", dir: "asc" })).toBe(
      "ORDER BY last_modified_ms IS NULL, last_modified_ms ASC, repo_id"
    );
  });

  it("omits the prefix when none is given", () => {
    expect(orderByClause({ ...HF, prefix: undefined, sort: "size", dir: "desc" })).toBe(
      "ORDER BY size_bytes DESC, repo_id COLLATE NOCASE"
    );
  });
});
