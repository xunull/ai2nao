import { describe, expect, it } from "vitest";
import { chromeHistoryUrlIdentity } from "../src/chromeHistory/domain.js";

describe("chromeHistoryUrlIdentity", () => {
  it("normalizes regular web hosts and folds one www prefix", () => {
    expect(chromeHistoryUrlIdentity("https://WWW.Example.COM/a").domain).toBe(
      "example.com"
    );
    expect(chromeHistoryUrlIdentity("https://www.www.example.com/a").domain).toBe(
      "www.example.com"
    );
  });

  it("keeps localhost traffic separate from web domains", () => {
    expect(chromeHistoryUrlIdentity("http://localhost:5173").urlKind).toBe(
      "localhost"
    );
    expect(chromeHistoryUrlIdentity("http://127.0.0.1:8787").domain).toBe(
      "localhost"
    );
  });

  it("classifies browser-internal, extension, file, and invalid URLs", () => {
    expect(chromeHistoryUrlIdentity("chrome://history").domain).toBe("chrome");
    expect(
      chromeHistoryUrlIdentity("chrome-extension://abcdef/options.html")
    ).toMatchObject({ urlKind: "extension", domain: "abcdef" });
    expect(chromeHistoryUrlIdentity("file:///tmp/a.txt")).toMatchObject({
      urlKind: "file",
      domain: null,
    });
    expect(chromeHistoryUrlIdentity("not a url")).toMatchObject({
      urlKind: "invalid",
      domain: null,
    });
  });
});
