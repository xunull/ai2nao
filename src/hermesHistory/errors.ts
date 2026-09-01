export type HermesErrorKind =
  | "db-not-found"
  | "db-unavailable"
  | "db-locked"
  | "schema-incompatible";

export type HermesDiagnostic = {
  kind: HermesErrorKind;
  message: string;
  path?: string;
};

export class HermesHistoryError extends Error {
  readonly kind: HermesErrorKind;
  readonly path?: string;

  constructor(kind: HermesErrorKind, message: string, path?: string) {
    super(message);
    this.name = "HermesHistoryError";
    this.kind = kind;
    this.path = path;
  }
}

export function isHermesHistoryError(e: unknown): e is HermesHistoryError {
  return e instanceof HermesHistoryError;
}

export function diagnosticFromError(e: unknown): HermesDiagnostic {
  if (isHermesHistoryError(e)) {
    return { kind: e.kind, message: e.message, path: e.path };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { kind: "db-unavailable", message: msg };
}

export function classifySqliteOpenError(e: unknown, dbPath: string): HermesHistoryError {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  if (lower.includes("locked") || lower.includes("busy")) {
    return new HermesHistoryError("db-locked", msg, dbPath);
  }
  return new HermesHistoryError("db-unavailable", msg, dbPath);
}
