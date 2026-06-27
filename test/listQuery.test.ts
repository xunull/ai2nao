import { describe, expect, it } from "vitest";
import { parseListQuery, type ListQueryOptions } from "../src/serve/listQuery.js";

function q(params: Record<string, string>) {
  return (key: string) => params[key];
}
const ok = (r: ListQueryOptions | { error: string }) => r as ListQueryOptions;

describe("parseListQuery sort/dir", () => {
  it("extracts a raw sort key and validated dir", () => {
    const r = ok(parseListQuery(q({ sort: "size", dir: "asc" })));
    expect(r.sort).toBe("size");
    expect(r.dir).toBe("asc");
  });

  it("passes the raw sort key through unvalidated (allowlist is downstream)", () => {
    // The parser is table-agnostic; it does NOT reject unknown keys here.
    expect(ok(parseListQuery(q({ sort: "anything" }))).sort).toBe("anything");
  });

  it("drops a malformed direction to undefined", () => {
    expect(ok(parseListQuery(q({ sort: "size", dir: "sideways" }))).dir).toBeUndefined();
  });

  it("drops an over-long sort key (defense in depth)", () => {
    expect(ok(parseListQuery(q({ sort: "x".repeat(65) }))).sort).toBeUndefined();
  });

  it("leaves sort/dir undefined when absent — existing callers unaffected", () => {
    const r = ok(parseListQuery(q({ q: "foo", limit: "10" })));
    expect(r.sort).toBeUndefined();
    expect(r.dir).toBeUndefined();
    // existing fields still parse exactly as before
    expect(r.q).toBe("foo");
    expect(r.limit).toBe(10);
    expect(r.offset).toBe(0);
    expect(r.includeMissing).toBe(false);
  });
});
