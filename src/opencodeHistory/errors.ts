export type OpencodeErrorKind =
  | "db-not-found"
  | "db-unavailable"
  | "db-locked"
  | "schema-incompatible";

export type OpencodeDiagnostic = {
  kind: OpencodeErrorKind;
  message: string;
  path?: string;
  count?: number;
};

export class OpencodeHistoryError extends Error {
  readonly kind: OpencodeErrorKind;
  readonly path?: string;

  constructor(kind: OpencodeErrorKind, message: string, path?: string) {
    super(message);
    this.name = "OpencodeHistoryError";
    this.kind = kind;
    this.path = path;
  }
}

export function isOpencodeHistoryError(e: unknown): e is OpencodeHistoryError {
  return e instanceof OpencodeHistoryError;
}

export function diagnosticFromError(e: unknown): OpencodeDiagnostic {
  if (isOpencodeHistoryError(e)) {
    return { kind: e.kind, message: e.message, path: e.path };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { kind: "db-unavailable", message: msg };
}

export function classifySqliteOpenError(e: unknown, dbPath: string): OpencodeHistoryError {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  if (lower.includes("locked") || lower.includes("busy")) {
    return new OpencodeHistoryError("db-locked", msg, dbPath);
  }
  return new OpencodeHistoryError("db-unavailable", msg, dbPath);
}
