// @vitest-environment jsdom

/**
 * `RenderedMarkdown` 的安全边界（承 20260707 codex #11 那条硬要求）。
 *
 * AI 输出是模型生成内容，可被 prompt injection 影响，按不可信输入对待。
 * react-markdown 默认把原始 HTML 全部转义，所以 XSS 面不扩大 —— 但这依赖三条配置：
 * 不加 `rehype-raw`、不覆盖 `urlTransform`、`components` 内不用
 * `dangerouslySetInnerHTML`。
 *
 * 这里有两层网：
 *
 * 1. **行为断言（主）** —— 加了 `rehype-raw` 会立刻变红，无论配置怎么写。
 *    断言必须写成「原始 HTML 以**字面串可见**」，**不能**写成「脚本不执行」：
 *    jsdom 里 React 插入的 `<script>` 本来就不执行，那种写法加不加 rehype-raw 都绿。
 *    同理别断言「没有 onerror 属性」—— 加了 rehype-raw 后 React 自己会丢掉 onerror，
 *    那条也不会红。靶子是**原始 HTML 是否透传**。
 *
 * 2. **源码扫描（辅）** —— 唯一能同时覆盖三条禁令、且改配置写法也扛得住的形态。
 *    扫的是**语法形态**（import 语句 / prop 赋值），**不是裸字符串**：
 *    `web/src` 里有多处「声明我没用它」的安全注释含这些词，扫裸串会出生即红。
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { RenderedMarkdown } from "../web/src/components/RenderedMarkdown";

afterEach(cleanup);

describe("RenderedMarkdown — 原始 HTML 一律转义（加 rehype-raw 会让这三条全红）", () => {
  it("<script> 以字面串可见，不成为元素", () => {
    const { container } = render(
      <RenderedMarkdown text={'前 <script>alert(1)</script> 后'} />
    );
    // 字面可见 = 没被解析成元素
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.querySelector("script")).toBeNull();
  });

  it("<img onerror> 以字面串可见，不成为元素", () => {
    const { container } = render(
      <RenderedMarkdown text={'正常字 <img src=x onerror="alert(1)"> 后面'} />
    );
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.querySelector("img")).toBeNull();
  });

  it("原始 HTML 块整串以字面量出现，内部 markdown 不被解析", () => {
    const { container } = render(
      <RenderedMarkdown text={'<div class="x">粗体 **不** 解析</div>'} />
    );
    expect(container.textContent).toContain('<div class="x">');
    expect(container.textContent).toContain("**不**");
    // 加了 rehype-raw 的话:div 会成为元素，且里面的 ** 会被解析成 strong
    expect(container.querySelector("div.x")).toBeNull();
    expect(container.querySelector("strong")).toBeNull();
  });

  it("注入内容里的尖括号一个字符不丢（<system-reminder> / Array<T>）", () => {
    const { container } = render(
      <RenderedMarkdown text={"<system-reminder>提醒</system-reminder> 与 Array<string>"} />
    );
    expect(container.textContent).toContain("<system-reminder>提醒</system-reminder>");
    expect(container.textContent).toContain("Array<string>");
  });

  it("正向标记：同一条内容里的真 markdown 确实被解析", () => {
    // 证明上面几条测的是**渲染路径**，不是某条恒真的空断言。
    render(<RenderedMarkdown text={"<b>字面</b> 和 **真粗体**"} />);
    expect(screen.getByText("真粗体").tagName).toBe("STRONG");
  });
});

describe("web/src 源码扫描 — 三条禁令（扫语法形态，不扫裸字符串）", () => {
  const FORBIDDEN: Array<{ name: string; re: RegExp; why: string }> = [
    {
      name: "rehype-raw",
      re: /from\s+["']rehype-raw["']|require\(\s*["']rehype-raw["']\s*\)/,
      why: "rehype-raw@7.0.0 已在根 node_modules(streamdown 传递依赖),import 它不需要 install、不产生 package.json diff、没有 review 信号",
    },
    {
      name: "urlTransform",
      re: /urlTransform\s*[=:]/,
      why: "官方文档明示覆盖 urlTransform 是唯一的自引入 XSS 途径",
    },
    {
      name: "dangerouslySetInnerHTML",
      re: /dangerouslySetInnerHTML\s*=/,
      why: "components 内不得绕过 React 的转义",
    },
  ];

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(p);
    }
    return out;
  }

  const ROOT = join(__dirname, "..", "web", "src");

  it("扫到的文件数合理（防止 walk 静默扫了个空目录）", () => {
    expect(walk(ROOT).length).toBeGreaterThan(20);
  });

  for (const { name, re, why } of FORBIDDEN) {
    it(`web/src 内没有 ${name} 的语法形态`, () => {
      const hits: string[] = [];
      for (const file of walk(ROOT)) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (re.test(line)) hits.push(`${file.replace(ROOT, "web/src")}:${i + 1}: ${line.trim()}`);
        });
      }
      expect(hits, `禁令「${name}」被破：${why}\n命中:\n${hits.join("\n")}`).toEqual([]);
    });
  }

  it("扫描规则本身不会被安全注释误伤（回归：初版扫裸字符串出生即红）", () => {
    // 这四行是 web/src 里真实存在的安全注释形态,必须全部躲开。
    const commentLines = [
      " * 安全:全部作文本 / React 节点渲染,绝不 dangerouslySetInnerHTML。",
      " * MessagePlainText / dangerouslySetInnerHTML),user 消息含任意内容也不扩大 XSS 面。",
      " *   1. **不加 rehype-raw** —— rehype-raw@7.0.0 已经躺在根 node_modules 里",
      " *   2. **不覆盖 urlTransform** —— 官方文档明示这是唯一的自引入 XSS 途径。",
    ];
    for (const line of commentLines) {
      for (const { name, re } of FORBIDDEN) {
        expect(re.test(line), `注释被禁令「${name}」误伤: ${line}`).toBe(false);
      }
    }
  });
});
