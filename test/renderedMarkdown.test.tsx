// @vitest-environment jsdom

/**
 * `RenderedMarkdown` 的渲染契约。
 *
 * **jsdom 不跑 CSS**，所以这里断言的是**结构**（渲染成了什么元素、拿到了哪些类），
 * 不是最终观感（字号、边框、颜色）。「标题看起来比正文大」这类只能由 `prose` 类
 * 加上真实 CSS 保证 —— 测试能守的是「元素是 h2」和「容器带 prose」，
 * 观感留给人眼与 e2e。这个边界写在这里，免得下一个人以为绿了就等于好看。
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { RenderedMarkdown } from "../web/src/components/RenderedMarkdown";

afterEach(cleanup);

function renderMd(text: string) {
  return render(<RenderedMarkdown text={text} />);
}

describe("RenderedMarkdown — 基本语法", () => {
  it("表格渲染成 table，不是竖线字面量", () => {
    const { container } = renderMd("| 列A | 列B |\n|---|---|\n| 1 | 2 |");
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(within(table!).getByText("列A")).toBeInTheDocument();
    expect(within(table!).getByText("2")).toBeInTheDocument();
    // 竖线不该以字面量出现
    expect(container.textContent).not.toContain("|---|");
  });

  it("表格外面包了一层可横向滚动的容器（CLAUDE.md：禁止页面横向滚动条）", () => {
    const { container } = renderMd("| 列A | 列B |\n|---|---|\n| 1 | 2 |");
    const table = container.querySelector("table");
    const wrapper = table?.parentElement;
    expect(wrapper?.className).toContain("overflow-x-auto");
    expect(wrapper?.className).toContain("max-w-full");
  });

  it("**粗体** 渲染成 strong，星号消失", () => {
    const { container } = renderMd("这是**重点**内容");
    expect(container.querySelector("strong")).toHaveTextContent("重点");
    expect(container.textContent).not.toContain("**");
  });

  it("## 渲染成 h2，井号消失", () => {
    const { container } = renderMd("## 结论");
    const h2 = container.querySelector("h2");
    expect(h2).toHaveTextContent("结论");
    expect(container.textContent).not.toContain("##");
  });

  it("`- a` / `- b` 渲染成两个 li（不是一段带横杠的文字）", () => {
    const { container } = renderMd("- 第一条\n- 第二条");
    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("第一条");
    expect(items[1]).toHaveTextContent("第二条");
  });

  it("有序列表渲染成 ol", () => {
    const { container } = renderMd("1. 甲\n2. 乙");
    expect(container.querySelector("ol")).not.toBeNull();
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("引用渲染成 blockquote", () => {
    const { container } = renderMd("> 引用的话");
    expect(container.querySelector("blockquote")).toHaveTextContent("引用的话");
  });

  it("容器带 prose 类 —— 排版全靠它，preflight 会把这些元素清零", () => {
    const { container } = renderMd("## 标题\n\n- 列表");
    const root = container.firstElementChild;
    expect(root?.className).toContain("prose");
    // max-w-none:本项目是 PC 工作台,不要 prose 默认的 65ch 窄栏
    expect(root?.className).toContain("max-w-none");
  });
});

describe("RenderedMarkdown — 行内代码 vs 代码块（判别式写反的头号症状）", () => {
  it("行内代码渲染成 code，且**不**被包进代码块外框", () => {
    const { container } = renderMd("看 `foo.ts:42` 这一行");
    const code = container.querySelector("code");
    expect(code).toHaveTextContent("foo.ts:42");
    // CodeBlock 会画一个带语言标签栏的外框;行内代码绝不该触发它
    expect(container.textContent).not.toContain("CODE");
    expect(container.querySelectorAll("pre")).toHaveLength(0);
  });

  it("带语言的围栏渲染成代码块，标签栏显示语言", () => {
    const { container } = renderMd("```ts\nconst a = 1\n```");
    expect(container.querySelector("pre")).not.toBeNull();
    expect(screen.getByText("ts")).toBeInTheDocument();
  });

  it("无语言标记的围栏仍是代码块，标签栏显示 code", () => {
    const { container } = renderMd("```\n裸围栏\n```");
    expect(container.querySelector("pre")).not.toBeNull();
    expect(screen.getByText("code")).toBeInTheDocument();
    expect(container.textContent).toContain("裸围栏");
  });

  it("代码块内容不带多余尾随空行（对齐 splitMarkdownFences 的去尾）", () => {
    const { container } = renderMd("```ts\nconst a = 1\n```");
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("const a = 1");
  });

  it("CRLF 与 LF 产出相同 —— 与 plain 路径的两步归一化对称", () => {
    // splitMarkdownFences.ts 做了 .replace(/\r\n/g,"\n") 再 .replace(/\n$/,"")。
    // pre 覆写只显式做了去尾,这条钉住「CRLF 归一化由 remark 负责」这个依赖,
    // 免得哪天上游变了之后 assistant 的代码块里冒出 \r。
    const lf = renderMd("```ts\nconst a = 1\n```").container.querySelector("pre")
      ?.textContent;
    cleanup();
    const crlf = renderMd("```ts\r\nconst a = 1\r\n```").container.querySelector(
      "pre"
    )?.textContent;
    expect(crlf).toBe(lf);
    expect(crlf).not.toContain("\r");
  });

  it("同时含行内代码与围栏时，只有围栏成块", () => {
    const { container } = renderMd("行内 `x` 在这里\n\n```js\nblock\n```");
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.textContent).toContain("x");
  });
});

describe("RenderedMarkdown — 换行与空态", () => {
  it("单换行保留（remark-breaks），textContent 与原文逐字符相同", () => {
    const src = "第一行\n第二行\n第三行";
    const { container } = renderMd(src);
    expect(container.querySelectorAll("br").length).toBeGreaterThan(0);
    // hast 在每个 <br> 后补 \n 文本节点,所以 textContent 与原文一致
    expect(container.textContent).toBe(src);
  });

  it("空行分段成多个 p", () => {
    const { container } = renderMd("第一段\n\n第二段");
    expect(container.querySelectorAll("p")).toHaveLength(2);
  });

  it("字面空串显示「（空消息）」占位", () => {
    renderMd("");
    expect(screen.getByText("（空消息）")).toBeInTheDocument();
  });

  it("纯空白**不**显示占位 —— 精确对齐 plain 路径的行为", () => {
    // splitMarkdownFences("   ") 返回一段 text,再被 !v.trim() 滤成空容器,无占位。
    // 若这里用 !text.trim() 判空,就会多出一个 plain 路径没有的占位。
    const { container } = renderMd("   ");
    expect(screen.queryByText("（空消息）")).toBeNull();
    expect(container.querySelector(".prose")).not.toBeNull();
  });
});
