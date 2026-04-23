/** Hard cap before reading a `.jsonl` into memory for detail views. */
export const MAX_JSONL_BYTES = 50 * 1024 * 1024;

/** Hard cap on logical lines (split on `\n`) for one transcript file. */
export const MAX_JSONL_LINES = 500_000;

/** Max chars for error responses that include a source snippet. */
export const MAX_RAW_SNIPPET_CHARS = 2_000;
