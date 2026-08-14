import { CodeBlock } from "./CodeBlock";
import { splitMarkdownFences } from "../util/splitMarkdownFences";

type Props = {
  text: string;
};

/**
 * 消息正文的**不解析**路径：普通文本原样换行 + 围栏代码块语法高亮。
 *
 * **它不渲染 markdown。** 除三反引号围栏外的一切语法(粗体、标题、列表、表格、
 * 行内代码、链接)都以字面量显示。这个组件曾叫 `MessageMarkdown`,那个名字骗过了
 * 4 份设计文档和 5 个页面共四个月 —— 改名就是为了让下一个人不必读实现才知道这件事。
 *
 * user 消息走这里(D3:真人发出去的原文不做显示层加工);assistant 正文与 thinking
 * 走 `RenderedMarkdown`。两条路径的代码块外框共用 `CodeBlock`。
 */
export function MessagePlainText({ text }: Props) {
  const parts = splitMarkdownFences(text);
  if (parts.length === 0) {
    return (
      <p className="text-sm italic text-neutral-400">（空消息）</p>
    );
  }

  return (
    <div className="space-y-3 text-[0.9375rem] leading-relaxed">
      {parts.map((p, i) => {
        if (p.type === "text") {
          const v = p.value;
          if (!v.trim()) return null;
          return (
            <div
              key={i}
              className="whitespace-pre-wrap break-words text-neutral-800"
            >
              {v}
            </div>
          );
        }
        return <CodeBlock key={i} code={p.value} language={p.lang} />;
      })}
    </div>
  );
}
