/**
 * Tiny ambient ports so the domain stays deterministic and testable: it never
 * reaches for `new Date()` or `crypto.randomUUID()` directly. Production wires
 * the system adapters (see ../runtime.ts); tests pass fakes.
 */
export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
