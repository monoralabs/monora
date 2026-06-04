import { TRPCError } from "@trpc/server";
import type { DomainError } from "@monora/core";

/** Map a domain error to the matching tRPC transport error. The domain never
 *  imports TRPCError; translation happens here at the interface edge. */
export function toTRPCError(e: DomainError): TRPCError {
  const code =
    e.code === "not_found"
      ? "NOT_FOUND"
      : e.code === "conflict"
        ? "CONFLICT"
        : e.code === "forbidden"
          ? "FORBIDDEN"
          : "BAD_REQUEST";
  return new TRPCError({ code, message: e.message });
}
