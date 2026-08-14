import { describe, expect, it } from "vitest";
import { splitMarkdownFences } from "../web/src/util/splitMarkdownFences.js";

describe("splitMarkdownFences", () => {
  it("splits text and one fenced block", () => {
    const md = "intro\n```ts\nconst x = 1\n```\ntrailer";
    const segs = splitMarkdownFences(md);
    expect(segs).toEqual([
      { type: "text", value: "intro\n" },
      { type: "code", lang: "ts", value: "const x = 1" },
      { type: "text", value: "\ntrailer" },
    ]);
  });

  it("handles empty fence lang", () => {
    const md = "```\nplain\n```";
    expect(splitMarkdownFences(md)).toEqual([
      { type: "code", lang: "", value: "plain" },
    ]);
  });
});

/**
 * 与 CommonMark 的已知差集 —— **这是刻意的，不是待修的 bug。**
 *
 * D3 把 user 消息冻在这个解析器上（真人发出去的原文不做显示层加工），assistant 走
 * react-markdown。于是同一段内容在两种气泡里表现不同：下面这些围栏 `RenderedMarkdown`
 * 认，`splitMarkdownFences` 不认，会当成普通文本原样显示。
 *
 * 写成断言是为了把**隐式分歧变成成文契约**：以后有人「顺手修一下这个正则」时，
 * 这里会红，他就得先来读这段说明，而不是无声地改变 user 侧的显示。
 *
 * 若哪天决定统一两侧口径，改的是这组断言的期望值，不是偷偷放宽正则。
 */
describe("splitMarkdownFences — 与 CommonMark 的已知差集（刻意保留）", () => {
  const notRecognized = [
    ["带元信息的 info string", '```js title="app.js"\nX\n```'],
    ["带高亮行号的 info string", "```ts {1,3}\nX\n```"],
    ["花括号 info string（RMarkdown）", "```{r}\nX\n```"],
    ["波浪线围栏", "~~~js\nX\n~~~"],
    ["未闭合围栏（消息被截断）", "```ts\nX 后面没有闭合"],
  ] as const;

  for (const [label, md] of notRecognized) {
    it(`不识别：${label} → 整段当普通文本`, () => {
      const segs = splitMarkdownFences(md);
      expect(segs).toEqual([{ type: "text", value: md }]);
    });
  }

  it("识别：普通 info string（含 c# / c++ / 带点 / 带数字）", () => {
    for (const tag of ["ts", "c#", "c++", "js.map", "python3", "diff-python"]) {
      const segs = splitMarkdownFences("```" + tag + "\nX\n```");
      expect(segs).toEqual([{ type: "code", lang: tag, value: "X" }]);
    }
  });

  it("4 空格缩进块不是围栏（react-markdown 侧会渲成代码块）", () => {
    const md = "普通段落\n\n    indented code\n";
    expect(splitMarkdownFences(md)).toEqual([{ type: "text", value: md }]);
  });

  it("CRLF 被归一化成 LF，且去掉尾随换行（RenderedMarkdown 的 pre 覆写要对齐这两步）", () => {
    expect(splitMarkdownFences("```ts\r\nconst a = 1\r\n```")).toEqual([
      { type: "code", lang: "ts", value: "const a = 1" },
    ]);
  });
});
