import { describe, expect, it } from "vitest";
import { tryPrettyJson } from "../web/src/util/jsonFormat.ts";

describe("tryPrettyJson", () => {
  it("pretty-prints valid JSON object", () => {
    expect(tryPrettyJson('{"a":1,"b":2}')).toBe(
      ["{", '  "a": 1,', '  "b": 2', "}"].join("\n")
    );
  });

  it("pretty-prints valid JSON array", () => {
    expect(tryPrettyJson("[1,2]")).toBe("[\n  1,\n  2\n]");
  });

  it("returns null for invalid JSON", () => {
    expect(tryPrettyJson("{")).toBeNull();
  });

  it("returns null for plain text", () => {
    expect(tryPrettyJson("hello")).toBeNull();
  });

  it("returns null when not object or array at start", () => {
    expect(tryPrettyJson('"only-string"')).toBeNull();
  });
});
