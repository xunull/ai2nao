import { CodeHighlighted } from "./CodeHighlighted";
import { splitMarkdownFences } from "../util/splitMarkdownFences";

type Props = {
  text: string;
};

/** 消息正文：普通文本原样换行 + 围栏代码块语法高亮 */
export function MessageMarkdown({ text }: Props) {
  const parts = splitMarkdownFences(text);
  if (parts.length === 0) {
    return <p className="text-sm text-[var(--muted)]">（空）</p>;
  }

  return (
    <div className="space-y-3 text-sm">
      {parts.map((p, i) => {
        if (p.type === "text") {
          const v = p.value;
          if (!v.trim()) return null;
          return (
            <div
              key={i}
              className="whitespace-pre-wrap break-words text-[var(--fg)] leading-relaxed"
            >
              {v}
            </div>
          );
        }
        return (
          <div
            key={i}
            className="rounded-md border border-[var(--border)] overflow-hidden shadow-sm"
          >
            <div className="text-xs px-2 py-1 bg-neutral-100 text-neutral-600 border-b border-[var(--border)] font-mono">
              {p.lang || "code"}
            </div>
            <CodeHighlighted code={p.value} language={p.lang} />
          </div>
        );
      })}
    </div>
  );
}
