/**
 * The one error type the domain raises. A code (mapped to a transport status
 * by callers) plus a human message. Use-cases catch this and return it as a
 * Result; anything that is NOT a DomainError is a real bug and propagates.
 */
export type DomainErrorCode =
  | "validation"
  | "conflict"
  | "not_found"
  | "forbidden";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }

  static validation(message: string): DomainError {
    return new DomainError("validation", message);
  }
  static conflict(message: string): DomainError {
    return new DomainError("conflict", message);
  }
  static notFound(message: string): DomainError {
    return new DomainError("not_found", message);
  }
  static forbidden(message: string): DomainError {
    return new DomainError("forbidden", message);
  }
}

/** Run a domain operation, funnelling DomainError into a Result and letting
 *  genuine bugs throw. Keeps every use-case's try/catch identical. */
export async function asResult<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: DomainError }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, error: e };
    throw e;
  }
}
