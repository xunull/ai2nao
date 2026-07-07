import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTROL_TAG_NAMES } from "../web/src/util/controlTags.js";

/**
 * 漂移守卫(codex #4):web/src/util/controlTags.ts 是仓库根
 * src/workCosmos/summarize.ts 里 CONTROL_TAG_PATTERNS 的前端副本(web 独立 TS 工程
 * import 不到 src/,只能复制)。这里读后端源码抽标签名,断言两边一致 —— 以后后端改了、
 * 前端漏改 → 测试红,不让语义静默分叉。
 */
const here = dirname(fileURLToPath(import.meta.url));
const summarizeSrc = readFileSync(
  resolve(here, "../src/workCosmos/summarize.ts"),
  "utf8"
);

// 从 `<\/tag-name>` 闭合标签字面里抽名字(只出现在 CONTROL_TAG_PATTERNS 块里)。
function tagsFromSummarize(): Set<string> {
  const names = new Set<string>();
  const re = /<\\\/([a-z-]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(summarizeSrc)) !== null) names.add(m[1]);
  return names;
}

describe("controlTags 漂移守卫 —— 前端副本 == 后端 summarize.ts", () => {
  it("两边标签名集合完全一致", () => {
    const backend = tagsFromSummarize();
    const frontend = new Set<string>(CONTROL_TAG_NAMES);
    // 后端至少解析出 12 个(防正则抽空导致假绿)。
    expect(backend.size).toBeGreaterThanOrEqual(12);
    expect([...frontend].sort()).toEqual([...backend].sort());
  });
});
