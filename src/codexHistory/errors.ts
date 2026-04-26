export type CodexErrorKind =
  | "root-not-found"
  | "state-db-unavailable"
  | "state-db-locked"
  | "schema-incompatible"
  | "transcript-missing"
  | "transcript-too-large"
  | "corrupt-jsonl-line";

export type CodexDiagnostic = {
  kind: CodexErrorKind;
  message: string;
  path?: string;
  count?: number;
};

export class CodexHistoryError extends Error {
  readonly kind: CodexErrorKind;
  readonly path?: string;

  constructor(kind: CodexErrorKind, message: string, path?: string) {
    super(message);
    this.name = "CodexHistoryError";
    this.kind = kind;
    this.path = path;
  }
}

export function isCodexHistoryError(e: unknown): e is CodexHistoryError {
  return e instanceof CodexHistoryError;
}

export function diagnosticFromError(e: unknown): CodexDiagnostic {
  if (isCodexHistoryError(e)) {
    return {
      kind: e.kind,
      message: e.message,
      path: e.path,
    };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return {
    kind: "state-db-unavailable",
    message: msg,
  };
}

export function classifySqliteOpenError(e: unknown, dbPath: string): CodexHistoryError {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  if (lower.includes("locked") || lower.includes("busy")) {
    return new CodexHistoryError("state-db-locked", msg, dbPath);
  }
  return new CodexHistoryError("state-db-unavailable", msg, dbPath);
}
