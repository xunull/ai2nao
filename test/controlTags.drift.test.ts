import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTROL_TAG_NAMES } from "../web/src/util/controlTags.js";
import { cleanClaudeUserMessage } from "../src/claudeCodeHistory/myMessages.js";

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

/**
 * 第三处口径(2026-08-17 补):`cleanClaudeUserMessage` 是清洗链上唯一决定
 * 「什么进 agent_user_messages.cleaned_text」的地方,而 cleaned_text 直接进 FTS。
 * 上面那条守的是 controlTags.ts ↔ summarize.ts,**守不到这里** —— bash-* 三个标签
 * 就是这么漏了四个月的(前端列进 CONTROL_TAG_NAMES,后端两条清洗路都不管,
 * 结果 `<bash-stdout>` 当人类词汇进了全文索引)。
 *
 * 这里断言的是**行为**不是名单:前端认定为控制标签的,后端清洗后标签字面必须消失。
 * 内容留不留是各标签的裁定(bash-input 留、stdout 整块剥),不在本守卫范围。
 */
describe("controlTags 漂移守卫 —— 后端 cleaner 覆盖前端认定的每个控制标签", () => {
  it.each([...CONTROL_TAG_NAMES])("<%s> 的标签字面不残留", (tag) => {
    const cleaned = cleanClaudeUserMessage(`<${tag}>NOISE_MARKER</${tag}>`);
    expect(cleaned).not.toContain(`<${tag}`);
    expect(cleaned).not.toContain(`</${tag}`);
  });

  it("守卫本身不会因为清单为空而假绿", () => {
    expect(CONTROL_TAG_NAMES.length).toBeGreaterThanOrEqual(12);
  });
});
