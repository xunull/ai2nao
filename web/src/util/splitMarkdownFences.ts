export type MdSegment =
  | { type: "text"; value: string }
  | { type: "code"; lang: string; value: string };

/**
 * 将 Markdown 正文按 ``` 围栏拆成文本段与代码段（用于代码高亮）。
 */
export function splitMarkdownFences(text: string): MdSegment[] {
  const segments: MdSegment[] = [];
  const re = /```([\w+.#-]*)\s*\r?\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      segments.push({ type: "text", value: text.slice(last, m.index) });
    }
    segments.push({
      type: "code",
      lang: (m[1] ?? "").trim(),
      value: m[2].replace(/\r\n/g, "\n").replace(/\n$/, ""),
    });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    segments.push({ type: "text", value: text.slice(last) });
  }
  return segments;
}
