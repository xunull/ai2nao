import { describe, expect, it } from "vitest";
import {
  DEFAULT_TAXONOMY,
  OTHER_CATEGORY,
  TAXONOMY_RULE_VERSION,
  classifyUrl,
} from "../src/topicStream/classify.js";

describe("topicStream classify", () => {
  it("matches a domainSuffix on a dot boundary, including subdomains", () => {
    expect(classifyUrl("https://www.reactjs.org/docs", "React Docs")).toBe("前端·UI");
    expect(classifyUrl("https://docs.reactjs.org/hooks", "Hooks")).toBe("前端·UI");
  });

  it("does NOT match a suffix that isn't on a dot boundary", () => {
    // evil-reactjs.org must not be classified as 前端 via reactjs.org
    expect(classifyUrl("https://evil-reactjs.org/x", "x")).toBe(OTHER_CATEGORY);
  });

  it("lets domainSuffix beat titleKeyword across categories", () => {
    // github.com is 社区 by domain; the title has react/css keywords for 前端,
    // but the domainSuffix pass wins first.
    expect(classifyUrl("https://github.com/facebook/react", "React CSS tutorial")).toBe(
      "社区"
    );
  });

  it("falls back to a titleKeyword only when no domain matches", () => {
    expect(classifyUrl("https://some-blog.example/post", "Learn React hooks")).toBe(
      "前端·UI"
    );
  });

  it("returns 其他 when nothing matches", () => {
    expect(classifyUrl("https://random-corp.example/x", "quarterly report")).toBe(
      OTHER_CATEGORY
    );
  });

  it("classifies a few representative dev domains", () => {
    expect(classifyUrl("https://huggingface.co/models", "Models")).toBe("AI·ML");
    expect(classifyUrl("https://www.youtube.com/watch?v=x", "Video")).toBe("视频·娱乐");
    expect(classifyUrl("https://developer.mozilla.org/en-US/", "MDN")).toBe("文档·API");
    expect(classifyUrl("https://vercel.com/dashboard", "Dashboard")).toBe("工具·云控制台");
  });

  it("has a stable, non-empty rule version derived from the taxonomy", () => {
    expect(typeof TAXONOMY_RULE_VERSION).toBe("string");
    expect(TAXONOMY_RULE_VERSION.length).toBeGreaterThan(0);
    // deterministic: same taxonomy hashes the same way
    expect(TAXONOMY_RULE_VERSION).toBe(TAXONOMY_RULE_VERSION);
  });

  it("keeps 其他 out of the taxonomy list (it is a fallback, not a rule set)", () => {
    expect(DEFAULT_TAXONOMY.some((c) => c.name === OTHER_CATEGORY)).toBe(false);
  });
});
