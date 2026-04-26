export type JsonlLineError = {
  line: number;
  message: string;
  rawSnippet: string;
};

export type JsonlLineOk = {
  line: number;
  record: Record<string, unknown>;
};

export type ParseJsonlResult = {
  okLines: JsonlLineOk[];
  errors: JsonlLineError[];
};

function snippet(raw: string, maxChars: number): string {
  const t = raw.trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "...";
}

/**
 * Parse JSONL text: one JSON object per non-empty line; corrupt lines are recorded and skipped.
 */
export function parseJsonlText(
  text: string,
  options?: { maxRawSnippetChars?: number }
): ParseJsonlResult {
  const maxRawSnippetChars = options?.maxRawSnippetChars ?? 300;
  const okLines: JsonlLineOk[] = [];
  const errors: JsonlLineError[] = [];
  const lines = text.split("\n");
  let lineNo = 0;
  for (const line of lines) {
    lineNo++;
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        errors.push({
          line: lineNo,
          message: "JSON root must be an object",
          rawSnippet: snippet(line, maxRawSnippetChars),
        });
        continue;
      }
      okLines.push({ line: lineNo, record: parsed as Record<string, unknown> });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({
        line: lineNo,
        message: msg,
        rawSnippet: snippet(line, maxRawSnippetChars),
      });
    }
  }
  return { okLines, errors };
}
