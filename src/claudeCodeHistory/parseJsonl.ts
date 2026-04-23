import { MAX_RAW_SNIPPET_CHARS } from "./constants.js";

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

function snippet(raw: string): string {
  const t = raw.trim();
  if (t.length <= MAX_RAW_SNIPPET_CHARS) return t;
  return t.slice(0, MAX_RAW_SNIPPET_CHARS) + "…";
}

/**
 * Parse JSONL text: one JSON object per non-empty line; corrupt lines are recorded and skipped.
 */
export function parseJsonlText(text: string): ParseJsonlResult {
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
          rawSnippet: snippet(line),
        });
        continue;
      }
      okLines.push({ line: lineNo, record: parsed as Record<string, unknown> });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ line: lineNo, message: msg, rawSnippet: snippet(line) });
    }
  }
  return { okLines, errors };
}
