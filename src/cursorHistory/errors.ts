export class SessionNotFoundError extends Error {
  constructor(identifier: string | number) {
    super(`Session not found: ${String(identifier)}`);
    this.name = "SessionNotFoundError";
  }
}
