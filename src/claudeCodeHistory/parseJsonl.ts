import { MAX_RAW_SNIPPET_CHARS } from "./constants.js";
import {
  parseJsonlText as parseSharedJsonlText,
  type JsonlLineError,
  type JsonlLineOk,
  type ParseJsonlResult,
} from "../localJsonl/parse.js";

export type { JsonlLineError, JsonlLineOk, ParseJsonlResult };

export function parseJsonlText(text: string): ParseJsonlResult {
  return parseSharedJsonlText(text, {
    maxRawSnippetChars: MAX_RAW_SNIPPET_CHARS,
  });
}
