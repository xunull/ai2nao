import { CodeHighlighted } from "./CodeHighlighted";

type Props = {
  code: string;
  /** 围栏上的语言标记，如 ts、json、bash；无标记时传空串。 */
  language: string;
};

/**
 * 围栏代码块的外框：圆角边框 + 语言标签栏 + `CodeHighlighted`。
 *
 * **两条消息渲染路径共用**：`MessagePlainText`(user) 与 `RenderedMarkdown`(assistant)。
 * 抽出来是为了避免同一个视觉归两个组件所有 —— `TODOS.md` 的
 * 「共享 AgentMessageTimeline 组件」那条 P2 把这类样式分叉列为待办问题。
 *
 * 注意这**不能**保证两条路径「看到的代码块集合」一致：围栏识别本身就不同
 * (`splitMarkdownFences` 的正则不认 ```js title="a.js"、~~~ 波浪线围栏、未闭合围栏，
 * 而 react-markdown 都认)。它只保证「进了这个框的」长得一样。
 *
 * 语言标记的取值范围两边已实测一致(ts / c# / c++ / f# / objective-c / 尾随空格 /
 * 大写 / 带点 / 带数字 十个用例)。未知语言由 `CodeHighlighted` 兜底成纯 pre，不会崩。
 */
export function CodeBlock({ code, language }: Props) {
  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200/90 shadow-sm ring-1 ring-black/[0.03]">
      <div className="flex items-center gap-2 border-b border-neutral-200/80 bg-neutral-50 px-3 py-2">
        <span className="font-mono text-[11px] font-medium uppercase tracking-wide text-neutral-500">
          {language || "code"}
        </span>
      </div>
      <CodeHighlighted code={code} language={language} />
    </div>
  );
}
