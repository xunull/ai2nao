import { useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { CodeBlock } from "./CodeBlock";

type Props = {
  text: string;
};

/**
 * 本项目**唯一**解析 markdown 的地方。assistant 正文与 thinking 走这里;
 * user 消息走 `MessagePlainText`(D3:真人发出去的原文不做显示层加工)。
 *
 * ## 安全边界(承 20260707 codex #11 那条硬要求)
 *
 * AI 输出是模型生成内容,可被 prompt injection 影响,按**不可信输入**对待。
 * 实测 react-markdown 默认把原始 HTML 全部转义(`<script>` / `<img onerror>` /
 * `<system-reminder>` / `Array<T>` 一个字符不丢),所以 XSS 面不扩大。但这依赖三条配置,
 * 改动任意一条都会把它变成可执行 HTML:
 *
 *   1. **不加 rehype-raw** —— `rehype-raw@7.0.0` 已经躺在根 node_modules 里
 *      (streamdown ← CopilotKit 的传递依赖),import 它不需要 install、不产生
 *      package.json diff、没有任何 review 信号。这是本条最危险的地方。
 *   2. **不覆盖 urlTransform** —— 官方文档明示这是唯一的自引入 XSS 途径。
 *   3. **components 内不得出现 dangerouslySetInnerHTML**。
 *
 * 三条都有测试守着(test/renderedMarkdown.security.test.tsx):三条行为断言 +
 * 一条扫 web/src 的源码扫描(扫 import/prop 语法形态,不是裸字符串 —— 扫裸串会被
 * 本文件这段注释和另外两处安全注释打红)。
 *
 * ## 为什么覆写 pre 而不是 code
 *
 * react-markdown >= 9 移除了 `inline` prop,`components.code` 对**行内代码和围栏
 * 代码块都触发**;而 className 不能当判别式 —— 无语言标记的围栏 className 是
 * undefined,与行内完全相同。把 code 接到块级组件上会让 8801 处行内代码
 * (47.4% 的消息,最高频语法)全变成代码块,正好毁掉本功能要修的头号问题。
 * `pre` 只对块级触发,从不对行内触发,是结构性的判别式。
 *
 * ## 刻意不做的事
 *
 * **不包错误边界。** micromark 对任意字符串是全函数;下面的 pre 覆写做了类型收窄,
 * 抛不出来。剩下的抛出源是配置写错 —— 那是确定性的、每条消息都触发的 bug,
 * 正确行为是测试炸红而不是全站静默降级(降级还会把上面三条安全断言洗成永真,
 * 因为 fallback 渲染字面 HTML 一样"可见")。CLAUDE.md §2:不为不可能的场景写错误处理。
 */
export function RenderedMarkdown({ text }: Props) {
  // 虚拟列表滚动会反复 render;锁在 text 上,同一条消息只解析一次。
  // 注意它活不过组件卸载(react-virtual 会卸载视口外的行),这是已知且接受的。
  const body = useMemo(
    () => (
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        // 空数组是**显式声明**,不是省略:这里永远不放 rehype-raw。见上方安全边界。
        rehypePlugins={[]}
        components={{
          pre: ({ node }) => {
            // 类型收窄是必需的,不是防御性编程:@types/hast 里 Element.children 是
            // ElementContent[] = Comment | Element | Text,Element 没有 value、
            // Text 没有 properties,而 web/tsconfig.json 是 strict。
            const codeNode = node?.children?.[0];
            const el = codeNode?.type === "element" ? codeNode : undefined;
            const cls = el?.properties?.className;
            const lang = Array.isArray(cls)
              ? (
                  cls.find((c) => String(c).startsWith("language-")) ?? ""
                )
                  .toString()
                  .replace("language-", "")
              : "";
            const first = el?.children?.[0];
            // 去尾换行:hast 的 value 带尾随 \n,而 plain 路径的
            // splitMarkdownFences.ts 做了 .replace(/\n$/, "")。不去的话 assistant
            // 的代码块会比 user 的多一行空行。
            const raw = (first?.type === "text" ? first.value : "").replace(
              /\n$/,
              ""
            );
            return <CodeBlock code={raw} language={lang} />;
          },
          // 宽表格在自己的容器里横向滚动,不撑破页面(CLAUDE.md:禁止横向滚动条)。
          // 用包裹层而不是给 table 上 display:block —— 后者会把表格自身的布局算法
          // 一起改掉(列宽不再按内容分配)。
          table: ({ children }) => (
            <div className="max-w-full overflow-x-auto">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    ),
    [text]
  );

  // 判据是**字面空串**,不是 !text.trim() —— 精确对齐 plain 路径:
  // splitMarkdownFences("") 返回 []（→「（空消息）」），而 "   " 返回一段 text
  // 再被 !v.trim() 滤掉（→ 空容器,无占位）。用 !text.trim() 会在纯空白上多出一个
  // plain 路径没有的占位,同一页面上两种气泡对同样输入给出不同结果。
  if (text === "") {
    return <p className="text-sm italic text-neutral-400">（空消息）</p>;
  }

  return (
    <div
      className={[
        // prose 补回 preflight 清零掉的 markdown 排版(标题字号、列表符号、表格边框、
        // 链接颜色、行内代码底色)。max-w-none 取消 prose 默认的 65ch 宽度上限 ——
        // 本项目是 PC 桌面工作台,不要书籍式窄栏。
        "prose prose-neutral max-w-none",
        "text-[0.9375rem] leading-relaxed text-neutral-800",
        // 代码块外框由 CodeBlock 自己画,清掉 prose 给 pre 的深色底与内距,
        // 否则会与 CodeHighlighted 的主题打架。
        "prose-pre:m-0 prose-pre:bg-transparent prose-pre:p-0",
      ].join(" ")}
    >
      {body}
    </div>
  );
}
