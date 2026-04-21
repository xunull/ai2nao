import { describe, expect, it } from "vitest";
import { redactAuth } from "../src/github/fetcher.js";

describe("redactAuth", () => {
  it("redacts bare ghp_ tokens in strings", () => {
    const s = "leaked token: ghp_abcdefghijklmnopqrstuvwxyz01234567";
    const out = redactAuth(s);
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz01234567");
    expect(out).toContain("***");
  });

  it("redacts github_pat_ and ghu_ variants too", () => {
    const s = "ghs_abcdefghijklmnopqrstuvwxyz01234567 and ghu_abcdefghijklmnopqrstuvwxyz01234567";
    const out = redactAuth(s);
    expect(out).not.toMatch(/gh[opusr]_[A-Za-z0-9_]{20,}/);
  });

  it("redacts Bearer gh* headers in free text", () => {
    const s = "curl: Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz01234567";
    const out = redactAuth(s);
    expect(out).toContain("Bearer ***");
    expect(out).not.toContain("Bearer ghp_");
  });

  it("replaces any field named authorization with ***", () => {
    const obj = {
      headers: { Authorization: "Bearer ghp_realtoken1234567890abcdef" },
      nested: { authorization: "whatever" },
    };
    const out = redactAuth(obj);
    expect(out.headers.Authorization).toBe("***");
    expect(out.nested.authorization).toBe("***");
  });

  it("walks into error.cause without leaking token strings", () => {
    const err = new Error("wrap");
    (err as { cause?: unknown }).cause = {
      message: "Bearer ghp_abcdefghijklmnopqrstuvwxyz01234567 expired",
    };
    const out = redactAuth(err.cause);
    expect(JSON.stringify(out)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz01234567");
  });

  it("handles cyclic structures without stack overflow", () => {
    const a: Record<string, unknown> = { name: "x" };
    a.self = a;
    expect(() => redactAuth(a)).not.toThrow();
  });

  it("leaves short tokens alone (no false positives)", () => {
    expect(redactAuth("ghp_short")).toBe("ghp_short");
  });

  it("passes through null/undefined/numbers", () => {
    expect(redactAuth(null)).toBeNull();
    expect(redactAuth(undefined)).toBeUndefined();
    expect(redactAuth(42)).toBe(42);
  });
});
