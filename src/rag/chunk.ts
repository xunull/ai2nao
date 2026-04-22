/** Target size for one chunk (characters). */
const TARGET = 2000;
const MIN_PARA = 400;

/**
 * Split markdown-ish text into chunks for indexing. Prefers paragraph breaks,
 * then merges until ~TARGET chars.
 */
export function chunkText(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").trim();
  if (!raw) return [];

  const paragraphs = raw.split(/\n{2,}/);
  const out: string[] = [];
  let buf = "";

  function flush() {
    const t = buf.trim();
    if (t) out.push(t);
    buf = "";
  }

  for (const p of paragraphs) {
    const block = p.trim();
    if (!block) continue;
    if (buf.length === 0) {
      buf = block;
      continue;
    }
    if (buf.length + 2 + block.length <= TARGET) {
      buf = `${buf}\n\n${block}`;
      continue;
    }
    if (buf.length >= MIN_PARA) {
      flush();
      buf = block;
    } else {
      buf = `${buf}\n\n${block}`;
    }
  }
  flush();

  if (out.length === 0) return [];
  // Hard cap very long single paragraphs
  return out.flatMap((c) => hardSplit(c, TARGET));
}

function hardSplit(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    parts.push(s.slice(i, i + max));
    i += max;
  }
  return parts;
}
