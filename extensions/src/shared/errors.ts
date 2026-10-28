/** Thrown when input breaks an invariant. Domain decisions are returned as values, never thrown. */
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'DomainError';
    this.code = code;
  }
}

export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new DomainError(code, message);
}
