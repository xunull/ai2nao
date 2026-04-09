import { CodeHighlighted } from "./CodeHighlighted";
import { splitMarkdownFences } from "../util/splitMarkdownFences";

type Props = {
  text: string;
};

/** 消息正文：普通文本原样换行 + 围栏代码块语法高亮 */
export function MessageMarkdown({ text }: Props) {
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
        return (
          <div
            key={i}
            className="overflow-hidden rounded-xl border border-neutral-200/90 shadow-sm ring-1 ring-black/[0.03]"
          >
            <div className="flex items-center gap-2 border-b border-neutral-200/80 bg-neutral-50 px-3 py-2">
              <span className="font-mono text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                {p.lang || "code"}
              </span>
            </div>
            <CodeHighlighted code={p.value} language={p.lang} />
          </div>
        );
      })}
    </div>
  );
}
