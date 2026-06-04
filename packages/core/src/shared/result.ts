/**
 * A tiny Result type. Use-cases return Result<T, DomainError> instead of
 * throwing transport errors; the interface layer (tRPC/CLI/MCP) maps the error
 * to its own surface. Domain code never imports TRPCError or HTTP status codes.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
